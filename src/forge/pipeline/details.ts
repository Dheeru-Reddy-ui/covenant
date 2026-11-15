import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import { DETAILS_VERSION, type DetailsFailure, PRODUCTION_MODEL, type SourceDocument, readContractDetails, sectionAt } from '../../../packages/core/src';
import { parseDocument, sha256Hex } from '../../parse/document';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError } from '../errors';
import { asApp, downloadAttachment } from '../jira';
import { ForgeLlmClient } from '../llm/forge-llm-client';
import { EXTRACTION_QUEUE } from './start';

/**
 * The details pass in Forge: after a contract's obligations are extracted, one
 * more model call reads its parties, notice address and methods, value and
 * service levels. It runs in the queue worker, never in a resolver. A failure
 * here never fails the extraction: the run records it, and the panel offers to
 * try again. Logs hold ids, counts and timings only.
 */

/** A details pass still marked running after this long was lost with its worker. */
const STALE_MS = 16 * 60 * 1000;

const FAILURE_TEXT: Record<DetailsFailure['reason'], string> = {
  empty_document: 'The file has no text Covenant can read.',
  too_long: 'The contract has more text than Covenant reads in one go.',
  no_tool_call: 'The model did not return an answer. Try again.',
  invalid_output: 'The model returned an answer Covenant could not use, twice. Try again.',
  llm_error: 'The call to the model failed. Try again.',
};

const queue = new Queue({ key: EXTRACTION_QUEUE });

/** Runs the pass for a run whose document is already parsed. Never throws. */
export async function runDetailsPass(run: repo.RunRow, contract: repo.ContractRow, source: SourceDocument): Promise<void> {
  const started = Date.now();
  try {
    if (!(await repo.claimDetailsRun(run.id, contract.id, DETAILS_VERSION, PRODUCTION_MODEL, started, started - STALE_MS))) {
      console.log(`details ${run.id} skipped: already done or running`);
      return;
    }
    const outcome = await readContractDetails(source, new ForgeLlmClient());
    const base = { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, calls: outcome.calls };
    if (outcome.status === 'failed') {
      await repo.finishDetailsRun(run.id, { ...base, status: 'failed', quotesReturned: 0, quotesVerified: 0, rejectedCount: 0, error: FAILURE_TEXT[outcome.reason] }, Date.now());
      console.log(`details ${run.id} failed reason=${outcome.reason} calls=${outcome.calls} tokens=${base.inputTokens}/${base.outputTokens} ms=${Date.now() - started}`);
      return;
    }

    // A retried pass replaces what an earlier, interrupted one left.
    await repo.deleteDetails(run.id);
    const counts: Record<string, number> = {};
    for (const d of outcome.details) {
      const ordinal = counts[d.kind] ?? 0;
      counts[d.kind] = ordinal + 1;
      await repo.insertDetail(
        {
          id: randomUUID(),
          runId: run.id,
          contractId: contract.id,
          kind: d.kind,
          ordinal,
          data: storable(d, source),
          quote: d.quote,
          page: d.location.page,
          pageEnd: d.location.pageEnd,
          ambiguous: d.location.ambiguous,
          section: sectionAt(source, d.location.match),
          confidence: d.confidence,
          status: d.status,
          review: d.review,
        },
        Date.now(),
      );
    }
    await repo.finishDetailsRun(
      run.id,
      { ...base, status: 'done', quotesReturned: outcome.grounding.quotesReturned, quotesVerified: outcome.grounding.quotesVerified, rejectedCount: outcome.rejected.length, error: null },
      Date.now(),
    );
    console.log(
      `details ${run.id} done items=${outcome.details.length} needsReview=${outcome.details.filter((d) => d.status === 'needs_review').length} rejected=${outcome.rejected.length} ` +
        `quotes=${outcome.grounding.quotesVerified}/${outcome.grounding.quotesReturned} calls=${outcome.calls} tokens=${base.inputTokens}/${base.outputTokens} ms=${Date.now() - started}`,
    );
  } catch (error) {
    console.error(`details ${run.id} failed error=${loggableError(error)} ms=${Date.now() - started}`);
    await repo
      .finishDetailsRun(run.id, { status: 'failed', inputTokens: 0, outputTokens: 0, calls: 0, quotesReturned: 0, quotesVerified: 0, rejectedCount: 0, error: 'Something went wrong while reading the details. Try again.' }, Date.now())
      .catch(() => undefined);
  }
}

/** A stored quote with where code found it: the nested credit and claim clauses of a service level keep their own. */
export interface StoredCitation {
  quote: string;
  page: number;
  pageEnd: number;
  section: ReturnType<typeof sectionAt>;
}

type Detail = Extract<Awaited<ReturnType<typeof readContractDetails>>, { status: 'ok' }>['details'][number];

/** The detail's data as stored: nested quote locations become page and clause, without offsets. */
function storable(d: Detail, source: SourceDocument): unknown {
  if (d.kind !== 'service_level') return d.data;
  const cite = (c: { quote: string; location: Detail['location'] }): StoredCitation => ({ quote: c.quote, page: c.location.page, pageEnd: c.location.pageEnd, section: sectionAt(source, c.location.match) });
  const { credit, claim, ...rest } = d.data;
  return {
    ...rest,
    credit: credit === null ? null : { ...cite(credit), percent: credit.percent, of: credit.of, per: credit.per },
    claim: claim === null ? null : { ...cite(claim), count: claim.count, unit: claim.unit, from: claim.from },
  };
}

/** The panel's "read the details" button, for runs extracted before the details pass existed or whose pass failed. */
export async function queueDetails(issueId: string, contractId: string): Promise<{ status: 'queued' | 'already' }> {
  await ensureSchema();
  const contract = await repo.getContract(contractId);
  if (contract === null || contract.issueId !== issueId) throw new UserFacingError('That contract belongs to a different work item.');
  const run = await repo.latestRun(contract.id);
  if (run === null || (run.status !== 'needs_review' && run.status !== 'approved')) throw new UserFacingError('This contract has not finished extraction yet.');
  if (!(await repo.markDetailsQueued(run.id, contract.id, DETAILS_VERSION, PRODUCTION_MODEL, Date.now()))) return { status: 'already' };
  try {
    await queue.push({ body: { runId: run.id, mode: 'details' } });
  } catch (error) {
    console.error(`details queue push failed run=${run.id} error=${loggableError(error)}`);
    await repo.finishDetailsRun(
      run.id,
      { status: 'failed', inputTokens: 0, outputTokens: 0, calls: 0, quotesReturned: 0, quotesVerified: 0, rejectedCount: 0, error: 'Covenant could not queue the reading. Try again.' },
      Date.now(),
    );
    throw new UserFacingError('Covenant could not queue the reading. Try again.');
  }
  console.log(`details ${run.id} queued contract=${contract.id}`);
  return { status: 'queued' };
}

/** The worker's path for a details-only job: read the file again and run the pass. Never throws. */
export async function detailsJob(runId: string): Promise<void> {
  try {
    const run = await repo.getRun(runId);
    const contract = run ? await repo.getContract(run.contractId) : null;
    if (run === null || contract === null) return;
    const bytes = await downloadAttachment(asApp(), contract.attachmentId);
    if (sha256Hex(bytes) !== contract.sha256) {
      await repo.claimDetailsRun(run.id, contract.id, DETAILS_VERSION, PRODUCTION_MODEL, Date.now(), Date.now());
      await repo.finishDetailsRun(
        run.id,
        { status: 'failed', inputTokens: 0, outputTokens: 0, calls: 0, quotesReturned: 0, quotesVerified: 0, rejectedCount: 0, error: 'The attachment has changed since it was extracted. Click Extract on it again.' },
        Date.now(),
      );
      return;
    }
    const parsed = await parseDocument(bytes);
    await runDetailsPass(run, contract, parsed.source);
  } catch (error) {
    console.error(`details ${runId} job failed error=${loggableError(error)}`);
    await repo
      .finishDetailsRun(runId, { status: 'failed', inputTokens: 0, outputTokens: 0, calls: 0, quotesReturned: 0, quotesVerified: 0, rejectedCount: 0, error: 'Covenant could not read the file again. Try again.' }, Date.now())
      .catch(() => undefined);
  }
}
