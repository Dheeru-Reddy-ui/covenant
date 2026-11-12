import { randomUUID } from 'node:crypto';
import type { AsyncEvent } from '@forge/events';
import {
  type ExtractionSuccess,
  type FailureReason,
  type SourceDocument,
  type VerifiedLocation,
  extractContract,
  normaliseWhitespace,
  scheduleRule,
  sectionAt,
} from '../../../packages/core/src';
import { parseDocument, sha256Hex } from '../../parse/document';
import { todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError, readableError } from '../errors';
import { asApp, downloadAttachment } from '../jira';
import { ForgeLlmClient } from '../llm/forge-llm-client';

/**
 * The queue consumer (timeoutSeconds 900): parse, extract, verify, resolve, persist.
 * Verification and the critic run inside extractContract; dates are resolved
 * here against today's date.
 *
 * It never throws once it holds a run: a thrown error makes Forge redeliver the
 * event for up to a day, so failures are recorded on the run instead, and the
 * reviewer retries with Extract. Logs hold ids, counts and timings only.
 */

const FAILURE_TEXT: Record<FailureReason, string> = {
  empty_document: 'This file has no text Covenant can read. Scanned PDFs need OCR, which Covenant does not do.',
  too_long: 'This contract has more text than Covenant reads in one go (about 100 pages).',
  no_tool_call: 'The model did not return an answer Covenant could use. Click Extract to try again.',
  invalid_output: "The model's answer failed Covenant's checks, even after one correction. Click Extract to try again.",
  llm_error: 'The call to the model failed. Click Extract to try again.',
};

interface ExtractionEventBody {
  runId?: unknown;
  [key: string]: unknown;
}

export async function handler(event: AsyncEvent<ExtractionEventBody>): Promise<void> {
  const runId = typeof event.body?.runId === 'string' ? event.body.runId : null;
  if (runId === null) {
    console.error(`extraction event without a run id job=${event.jobId}`);
    return;
  }
  const started = Date.now();
  // Before the claim nothing is lost by a retry, so a database that is not ready yet may throw and be redelivered.
  await ensureSchema();
  if (!(await repo.claimRun(runId, started))) {
    console.log(`run ${runId} skipped: not queued (already taken or finished)`);
    return;
  }

  try {
    await processRun(runId, started);
  } catch (error) {
    console.error(`run ${runId} failed error=${loggableError(error)} ms=${Date.now() - started}`);
    const message = readableError(error, 'Something went wrong while reading the contract. Click Extract to try again.');
    await repo.failRun(runId, 'worker_error', message, {}, Date.now()).catch((e: unknown) => {
      console.error(`run ${runId} could not be marked failed error=${loggableError(e)}`);
    });
  }
}

async function processRun(runId: string, started: number): Promise<void> {
  const run = await repo.getRun(runId);
  if (run === null) throw new Error('run not found');
  const contract = await repo.getContract(run.contractId);
  if (contract === null) throw new Error('contract not found');

  const bytes = await downloadAttachment(asApp(), contract.attachmentId);
  if (sha256Hex(bytes) !== contract.sha256) {
    throw new UserFacingError('The attachment no longer matches the file Covenant was asked to read. Click Extract on it again.');
  }
  const downloaded = Date.now();

  const parsed = await parseDocument(bytes);
  const pages = parsed.source.pages.length;
  const chars = parsed.source.pages.reduce((sum, p) => sum + normaliseWhitespace(p.text).length, 0);
  const parsedAt = Date.now();

  const llm = new ForgeLlmClient();
  const outcome = await extractContract(parsed.source, llm);
  const extractedAt = Date.now();
  const timings = `download=${downloaded - started} parse=${parsedAt - downloaded} extract=${extractedAt - parsedAt}`;

  if (outcome.status === 'failed') {
    const detail = outcome.reason === 'llm_error' ? ` (${outcome.detail.slice(0, 300)})` : '';
    await repo.failRun(
      runId,
      outcome.reason,
      `${FAILURE_TEXT[outcome.reason]}${detail}`,
      { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, llmCalls: outcome.calls, pages, chars },
      Date.now(),
    );
    console.log(
      `run ${runId} failed reason=${outcome.reason} error=${outcome.detail.split(':')[0]} pages=${pages} chars=${chars} calls=${outcome.calls} ` +
        `tokens=${outcome.usage.inputTokens}/${outcome.usage.outputTokens} ${timings}`,
    );
    return;
  }

  const saved = await persist(run, contract, outcome, { pages, chars, paginated: parsed.paginated, source: parsed.source });
  console.log(
    `run ${runId} needs_review obligations=${saved.obligations} needsReview=${saved.flagged} rejected=${outcome.rejected.length} ` +
      `quotes=${outcome.grounding.quotesVerified}/${outcome.grounding.quotesReturned} secondPasses=${outcome.secondPasses} pages=${pages} chars=${chars} ` +
      `calls=${outcome.calls} tokens=${outcome.usage.inputTokens}/${outcome.usage.outputTokens} ${timings} persist=${Date.now() - extractedAt}`,
  );
}

async function persist(
  run: repo.RunRow,
  contract: repo.ContractRow,
  outcome: ExtractionSuccess,
  doc: { pages: number; chars: number; paginated: boolean; source: SourceDocument },
): Promise<{ obligations: number; flagged: number }> {
  // A redelivered or retried run may have left rows from an attempt that died part way.
  await repo.deleteRunContent(run.id);

  const saveClause = async (role: repo.ClauseRow['role'], location: VerifiedLocation, quote: string): Promise<string> => {
    const id = randomUUID();
    // The clause number is found by code from where the quote sits, like the page.
    const section = sectionAt(doc.source, location.match);
    await repo.insertClause(
      {
        id,
        runId: run.id,
        contractId: contract.id,
        role,
        quote,
        page: location.page,
        pageEnd: location.pageEnd,
        startOffset: location.match.startOffset,
        endOffset: location.match.endOffset,
        occurrences: location.occurrences,
        ambiguous: location.ambiguous,
        section,
      },
      section,
      Date.now(),
    );
    return id;
  };

  const storeFact = async <V>(
    role: repo.ClauseRow['role'],
    fact: { status: 'ready' | 'needs_review'; value: V | null; reading: { quote: string; confidence: string }; location: VerifiedLocation; review: repo.StoredFact<V>['review']; secondReading: unknown } | null,
  ): Promise<repo.StoredFact<V>> => {
    if (fact === null) return { status: 'missing', value: null, clauseId: null, confidence: null, review: [], secondReading: null };
    return {
      status: fact.status,
      value: fact.value,
      clauseId: await saveClause(role, fact.location, fact.reading.quote),
      confidence: fact.reading.confidence,
      review: fact.review,
      secondReading: fact.secondReading,
    };
  };

  const facts: repo.StoredFacts = {
    effectiveDate: await storeFact('effective_date', outcome.effectiveDate),
    term: await storeFact('term', outcome.term),
    renewal: await storeFact('renewal', outcome.renewal),
    editedBy: null,
    editedAtMs: null,
  };
  const autoRenew = outcome.renewal?.status === 'ready' && outcome.renewal.value?.automatic === true;
  const terms = outcome.contractTerms;
  const today = todayUtc();

  let flagged = 0;
  for (const [ordinal, obligation] of outcome.obligations.entries()) {
    const clauseId = await saveClause('obligation', obligation.location, obligation.rule.quote);
    const schedule = scheduleRule(obligation.rule, { terms, today, autoRenew, minTermIndex: contract.termIndex });
    if (obligation.status === 'needs_review') flagged += 1;
    await repo.insertObligation({
      id: randomUUID(),
      runId: run.id,
      contractId: contract.id,
      clauseId,
      ordinal,
      rule: obligation.rule,
      originalRule: obligation.rule,
      secondRule: obligation.secondReading,
      extractorStatus: obligation.status,
      review: obligation.review,
      decision: 'pending',
      eventDate: null,
      dueDate: schedule.status === 'undated' ? null : schedule.due,
      scheduleStatus: schedule.status,
      workItemId: null,
      workItemKey: null,
      lastError: null,
      decidedBy: null,
      decidedAtMs: null,
      updatedAtMs: Date.now(),
    });
  }

  await repo.completeRun(
    run.id,
    {
      model: outcome.model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      llmCalls: outcome.calls,
      secondPasses: outcome.secondPasses,
      repaired: outcome.repaired,
      quotesReturned: outcome.grounding.quotesReturned,
      quotesVerified: outcome.grounding.quotesVerified,
      rejectedCount: outcome.rejected.length,
      pages: doc.pages,
      chars: doc.chars,
      paginated: doc.paginated,
    },
    facts,
    terms,
    autoRenew,
    Date.now(),
  );
  return { obligations: outcome.obligations.length, flagged };
}
