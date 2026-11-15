import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import {
  EVIDENCE_VERSION,
  type EvidenceFailure,
  type EvidenceFinding,
  type EvidenceSuccess,
  type IsoDate,
  KIND_LABELS,
  type PartyData,
  PRODUCTION_MODEL,
  checkEvidence,
  clauseLocation,
  describeSection,
  draftChase,
  textAround,
} from '../../../packages/core/src';
import { UnsupportedDocumentError, parseDocument, sha256Hex } from '../../parse/document';
import type { EvidenceCheckView, EvidenceView } from '../../shared/evidence';
import { scheduleFor, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError } from '../errors';
import { type IssueInfo, type Requester, addComment, asApp, asUser, downloadAttachment, getIssue, issueHeader, uploadAttachment } from '../jira';
import { sampleCertificates } from '../../../samples/fictional/workspace';
import { DOCX_TYPE, buildContractDocx } from '../../sample/docx';
import type { SampleStatus } from '../../shared/admin';
import { ForgeLlmClient } from '../llm/forge-llm-client';
import { SAMPLE_WORKSPACE, getJson } from '../settings';
import { EXTRACTION_QUEUE, MAX_ATTACHMENT_BYTES } from './start';

/**
 * The evidence check in Forge. A certificate or report attached to an
 * obligation's work item is read against that obligation's clause, in the
 * queue worker. Code decides pass, fail or needs review (packages/core
 * evidence.ts); a file Covenant cannot read is "needs review", never a guess.
 * Nothing is written to Jira unless a person clicks to post the chase draft.
 * Logs hold ids, counts and timings only.
 */

/** Kinds where the other party owes a document: an insurance certificate, an audit or service level report. */
const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['audit_insurance', 'reporting_deliverable']);
const SUPPORTED_NAME = /\.(pdf|docx)$/i;
const STALE_MS = 16 * 60 * 1000;

const queue = new Queue({ key: EXTRACTION_QUEUE });

const FAILURE_TEXT: Record<EvidenceFailure['reason'], string> = {
  empty_document: 'The file has no text Covenant can read. A scanned document needs a person to check it.',
  too_long: 'The file has more text than Covenant reads for an evidence check. A person needs to check it.',
  no_tool_call: 'The model did not return an answer. Try again.',
  invalid_output: 'The model returned an answer Covenant could not use, twice. Try again.',
  llm_error: 'The call to the model failed. Try again.',
};

/** Failures that mean the file itself cannot be checked: a person must look, and trying again will not help. */
const UNREADABLE: ReadonlySet<EvidenceFailure['reason']> = new Set(['empty_document', 'too_long']);

export const REASON_TEXT: Record<string, string> = {
  nothing_checked: 'Covenant found nothing in the clause it could check this document against.',
  document_reads_like_instruction: 'The document contains text that reads like an instruction to an AI. Covenant did not act on it; a person should check the document.',
  expired: 'The document does not stay valid for as long as the clause requires.',
  expiry_missing: 'The certificate does not say when it expires.',
  expiry_quote_not_found: 'The expiry date the model quoted is not in the document.',
  party_mismatch: 'The document is issued to a different party from the one the clause binds.',
  party_missing: 'The certificate does not name who it covers.',
  party_not_confirmed: 'Covenant does not know the name of the party the clause binds, so it could not compare names. Confirm the parties in the contract panel.',
  party_quote_not_found: 'The party name the model quoted is not in the document.',
  low_confidence: 'The model was unsure about a requirement.',
  evidence_quote_not_found: 'The document text the model quoted for a requirement is not in the document.',
  met_without_quote: 'A requirement was marked as met without quoting the document.',
  reads_like_instruction: 'A quoted passage of the document reads like an instruction to an AI.',
  unreadable: 'Covenant could not read this file.',
};

const reasonText = (code: string): string => {
  if (code.startsWith('expiry_unreadable:')) return `The expiry date is written in a way Covenant will not guess at (${code.split(':')[1]?.replace(/_/g, ' ')}).`;
  return REASON_TEXT[code] ?? code;
};

/** What is stored in result_json: the core outcome's findings plus the chase draft, built once. */
interface StoredResult {
  documentKind: string | null;
  findings: EvidenceFinding[];
  expiry: EvidenceSuccess['expiry'];
  party: EvidenceSuccess['party'];
  reasons: string[];
  chase: string[];
  paginated: boolean;
  grounding?: EvidenceSuccess['grounding'];
  asOf: IsoDate;
}

interface ObligationBundle {
  obligation: repo.ObligationRow;
  contract: repo.ContractRow;
  run: repo.RunRow;
  clause: repo.ClauseRow | null;
}

async function bundleFor(obligation: repo.ObligationRow): Promise<ObligationBundle> {
  const [contract, run, clause] = await Promise.all([repo.getContract(obligation.contractId), repo.getRun(obligation.runId), repo.getClause(obligation.clauseId)]);
  if (contract === null || run === null) throw new Error('obligation without contract or run');
  return { obligation, contract, run, clause };
}

/** The last day a document must be valid through: the next time the clause asks for one. Null when the obligation is undated. */
function requiredUntilOf(b: ObligationBundle, today: IsoDate): IsoDate | null {
  const schedule = scheduleFor(b.obligation.rule, b.run, b.contract, b.obligation.eventDate, today);
  return schedule.status === 'upcoming' ? schedule.due : null;
}

/** The party the clause binds, with its name, from the details pass. Null when not found or rejected. */
async function expectedPartyOf(b: ObligationBundle): Promise<{ label: string; name: string } | null> {
  const label = b.obligation.rule.responsibleParty.trim().toLowerCase();
  const parties = (await repo.listDetails(b.run.id)).filter((d) => d.kind === 'party' && d.decision !== 'rejected').map((d) => d.data as PartyData);
  const match = parties.find((p) => p.label.trim().toLowerCase() === label) ?? parties.find((p) => p.name.trim().toLowerCase() === label);
  return match ? { label: match.label, name: match.name } : null;
}

/**
 * The contract text around the obligation's clause, read again from the
 * contract's file, because a clause often refers to its neighbour ("the
 * insurance required by this clause"). Null when the file has changed or
 * cannot be read: the check then uses the clause alone.
 */
async function contractContext(b: ObligationBundle, quote: string): Promise<string | null> {
  try {
    const bytes = await downloadAttachment(asApp(), b.contract.attachmentId);
    if (sha256Hex(bytes) !== b.contract.sha256) return null;
    const parsed = await parseDocument(bytes);
    return textAround(quote, parsed.source, b.clause?.page ?? null);
  } catch (error) {
    console.log(`evidence context unavailable contract=${b.contract.id} error=${loggableError(error)}`);
    return null;
  }
}

/** Queues a check of one attachment on an obligation's work item. `requester` decides who must be able to see it. */
export async function startEvidenceCheck(
  issueId: string,
  attachmentId: string,
  by: {
    accountId: string | null;
    source: 'panel' | 'attachment';
    requester: Requester;
  },
): Promise<{
  status: 'queued' | 'already' | 'not_an_obligation';
  checkId: string | null;
}> {
  await ensureSchema();
  const obligation = await repo.findObligationByWorkItem(issueId);
  if (obligation === null) return { status: 'not_an_obligation', checkId: null };
  const issue: IssueInfo = await getIssue(by.requester, issueId);
  const attachment = issue.attachments.find((a) => a.id === attachmentId);
  if (attachment === undefined) throw new UserFacingError('That file is not attached to this work item.');
  if (!SUPPORTED_NAME.test(attachment.filename)) throw new UserFacingError('Covenant checks PDF and Word (.docx) files.');
  if (attachment.size > MAX_ATTACHMENT_BYTES) throw new UserFacingError('The file is larger than Covenant reads (15 MB).');

  const { id, queued } = await repo.queueEvidenceCheck(
    {
      id: randomUUID(),
      obligationId: obligation.id,
      contractId: obligation.contractId,
      issueId,
      attachmentId,
      fileName: attachment.filename,
      source: by.source,
      evidenceVersion: EVIDENCE_VERSION,
      model: PRODUCTION_MODEL,
      requestedBy: by.accountId,
    },
    Date.now(),
  );
  if (!queued) return { status: 'already', checkId: id };
  try {
    await queue.push({
      body: { runId: obligation.runId, mode: 'evidence', checkId: id },
    });
  } catch (error) {
    console.error(`evidence ${id} queue push failed error=${loggableError(error)}`);
    await repo.finishEvidenceCheck(
      id,
      {
        status: 'failed',
        verdict: null,
        result: null,
        model: PRODUCTION_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        error: 'Covenant could not queue the check. Try again.',
      },
      Date.now(),
    );
    throw new UserFacingError('Covenant could not queue the check. Try again.');
  }
  console.log(`evidence ${id} queued obligation=${obligation.id} source=${by.source}`);
  return { status: 'queued', checkId: id };
}

/** The worker's path for an evidence job. Never throws. */
export async function evidenceJob(checkId: string): Promise<void> {
  const started = Date.now();
  try {
    if (!(await repo.claimEvidenceCheck(checkId, started, started - STALE_MS))) {
      console.log(`evidence ${checkId} skipped: not queued`);
      return;
    }
    const check = await repo.getEvidenceCheck(checkId);
    const obligation = check ? await repo.getObligation(check.obligationId) : null;
    if (check === null || obligation === null) return;
    const b = await bundleFor(obligation);
    const asOf = todayUtc();
    const base = {
      documentKind: null,
      findings: [],
      expiry: null,
      party: null,
      chase: [],
      paginated: true,
      asOf,
    };

    let parsed: Awaited<ReturnType<typeof parseDocument>>;
    try {
      parsed = await parseDocument(await downloadAttachment(asApp(), check.attachmentId));
    } catch (error) {
      // A file that cannot be opened is for a person to check, not a failure to retry.
      const why = error instanceof UnsupportedDocumentError ? 'The file is not a PDF or Word file Covenant can open.' : 'Covenant could not open the file.';
      await repo.finishEvidenceCheck(
        checkId,
        {
          status: 'done',
          verdict: 'needs_review',
          result: { ...base, reasons: ['unreadable'] } satisfies StoredResult,
          model: PRODUCTION_MODEL,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          error: why,
        },
        Date.now(),
      );
      console.log(`evidence ${checkId} unreadable error=${loggableError(error)} ms=${Date.now() - started}`);
      return;
    }

    const quote = b.clause?.quote ?? obligation.rule.quote;
    const outcome = await checkEvidence(
      {
        kind: obligation.rule.kind,
        summary: obligation.rule.summary,
        quote,
        context: await contractContext(b, quote),
      },
      parsed.source,
      new ForgeLlmClient(),
      {
        asOf,
        requiredUntil: requiredUntilOf(b, asOf),
        expectedParty: await expectedPartyOf(b),
      },
    );
    const usage = {
      model: outcome.model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      calls: outcome.calls,
    };

    if (outcome.status === 'failed') {
      const unreadable = UNREADABLE.has(outcome.reason);
      await repo.finishEvidenceCheck(
        checkId,
        {
          ...usage,
          status: unreadable ? 'done' : 'failed',
          verdict: unreadable ? 'needs_review' : null,
          result: unreadable
            ? ({
                ...base,
                paginated: parsed.paginated,
                reasons: ['unreadable'],
              } satisfies StoredResult)
            : null,
          error: FAILURE_TEXT[outcome.reason],
        },
        Date.now(),
      );
      console.log(`evidence ${checkId} failed reason=${outcome.reason} calls=${outcome.calls} ms=${Date.now() - started}`);
      return;
    }

    const issueTitle = (await issueHeader(asApp(), b.contract.issueId).catch(() => null))?.summary || b.contract.issueKey;
    const location = b.clause
      ? clauseLocation({
          page: b.clause.page,
          pageEnd: b.clause.pageEnd,
          paginated: b.run.paginated,
          section: b.clause.section,
        })
      : 'the contract';
    const chase =
      outcome.verdict === 'fail'
        ? draftChase({
            fileName: check.fileName,
            contractTitle: issueTitle,
            clauseLocation: location,
            paginated: parsed.paginated,
            findings: outcome.findings,
            expiry: outcome.expiry,
            party: outcome.party,
          })
        : [];
    const result: StoredResult = {
      documentKind: outcome.documentKind,
      findings: outcome.findings,
      expiry: outcome.expiry,
      party: outcome.party,
      reasons: outcome.reasons,
      chase,
      paginated: parsed.paginated,
      grounding: outcome.grounding,
      asOf,
    };
    await repo.finishEvidenceCheck(
      checkId,
      {
        ...usage,
        status: 'done',
        verdict: outcome.verdict,
        result,
        error: null,
      },
      Date.now(),
    );
    console.log(
      `evidence ${checkId} done verdict=${outcome.verdict} findings=${outcome.findings.length} reasons=${outcome.reasons.join(',') || 'none'} ` +
        `quotes=${outcome.grounding.quotesVerified}/${outcome.grounding.quotesReturned} calls=${outcome.calls} tokens=${usage.inputTokens}/${usage.outputTokens} ms=${Date.now() - started}`,
    );
  } catch (error) {
    console.error(`evidence ${checkId} failed error=${loggableError(error)} ms=${Date.now() - started}`);
    await repo
      .finishEvidenceCheck(
        checkId,
        {
          status: 'failed',
          verdict: null,
          result: null,
          model: PRODUCTION_MODEL,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          error: 'Something went wrong during the check. Try again.',
        },
        Date.now(),
      )
      .catch(() => undefined);
  }
}

function checkView(c: repo.EvidenceCheckRow): EvidenceCheckView {
  const r = (c.result ?? null) as StoredResult | null;
  return {
    id: c.id,
    attachmentId: c.attachmentId,
    fileName: c.fileName,
    status: c.status,
    verdict: c.verdict,
    documentKind: r?.documentKind ?? null,
    findings: (r?.findings ?? []).map((f) => ({
      requirement: f.requirement,
      result: f.result,
      clauseQuote: f.clauseQuote,
      evidenceQuote: f.evidenceQuote,
      evidencePage: f.evidencePage,
      notes: f.review.map(reasonText),
    })),
    expiry: r?.expiry ?? null,
    party: r?.party ?? null,
    reasons: (r?.reasons ?? []).map(reasonText),
    chase: r?.chase ?? [],
    error: c.error,
    source: c.source,
    finishedAtMs: c.finishedAtMs,
    commented: c.commentedBy !== null,
    paginated: r?.paginated ?? true,
  };
}

/** The panel's view for a work item Covenant created for an approved obligation, or null for any other work item. */
export async function evidenceView(issue: IssueInfo, today: IsoDate): Promise<EvidenceView | null> {
  const obligation = await repo.findObligationByWorkItem(issue.id);
  if (obligation === null) return null;
  const b = await bundleFor(obligation);
  const [checks, expected, samples] = await Promise.all([repo.listEvidenceChecks(obligation.id), expectedPartyOf(b), offersSampleCertificates(obligation, b.contract)]);
  const latest = new Map<string, repo.EvidenceCheckRow>();
  for (const c of checks) if (!latest.has(c.attachmentId) || c.evidenceVersion > (latest.get(c.attachmentId)?.evidenceVersion ?? 0)) latest.set(c.attachmentId, c);
  return {
    obligationId: obligation.id,
    kindLabel: KIND_LABELS[obligation.rule.kind],
    summary: obligation.rule.summary,
    party: obligation.rule.responsibleParty,
    contractKey: b.contract.issueKey,
    contractId: b.contract.id,
    contractFile: b.contract.fileName,
    clause: b.clause
      ? {
          quote: b.clause.quote,
          page: b.clause.page,
          pageEnd: b.clause.pageEnd,
          paginated: b.run.paginated,
          ambiguous: b.clause.ambiguous,
          section: b.clause.section ? describeSection(b.clause.section) : null,
        }
      : null,
    expectsDocument: DOCUMENT_KINDS.has(obligation.rule.kind),
    requiredUntil: requiredUntilOf(b, today),
    expectedParty: expected?.name ?? null,
    sampleCertificates: samples,
    attachments: issue.attachments.map((a) => {
      const check = latest.get(a.id);
      return {
        id: a.id,
        fileName: a.filename,
        supported: SUPPORTED_NAME.test(a.filename),
        tooLarge: a.size > MAX_ATTACHMENT_BYTES,
        check: check ? checkView(check) : null,
      };
    }),
  };
}

/** A person's click: the chase draft goes on the work item as a comment, as that person. Covenant never sends it to the supplier. */
export async function postChase(issueId: string, checkId: string, accountId: string): Promise<{ commented: boolean }> {
  await ensureSchema();
  const check = await repo.getEvidenceCheck(checkId);
  if (check === null || check.issueId !== issueId) throw new UserFacingError('That check belongs to a different work item.');
  const chase = ((check.result ?? null) as StoredResult | null)?.chase ?? [];
  if (check.verdict !== 'fail' || chase.length === 0) throw new UserFacingError('There is no chase draft for this check.');
  const issue = await getIssue(asUser(), issueId);
  if (!(await repo.markEvidenceCommented(checkId, accountId))) return { commented: false };
  try {
    await addComment(asUser(), issue.key, {
      type: 'doc',
      version: 1,
      content: chase.map((line, i) =>
        i === 0
          ? {
              type: 'panel',
              attrs: { panelType: 'warning' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: line, marks: [{ type: 'strong' }] }],
                },
              ],
            }
          : line === ''
            ? { type: 'paragraph', content: [] }
            : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
    });
  } catch (error) {
    await repo.unmarkEvidenceCommented(checkId).catch(() => undefined);
    throw error;
  }
  console.log(`evidence ${checkId} chase posted`);
  return { commented: true };
}

export const isDocumentKind = (kind: string): boolean => DOCUMENT_KINDS.has(kind);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null);
const at = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

/**
 * Evidence on receipt: the avi:jira:created:attachment trigger. When a file
 * arrives on the work item of an approved obligation that expects a document
 * (an insurance certificate or a report), the check is queued at once, as the
 * app. Every other attachment is ignored after one database lookup. Spike S7
 * (docs/spikes.md) found the payload: attachment {id, issueId, projectId,
 * fileName, createDate, size, mimeType, author}, plus atlassianId and
 * selfGenerated. Uploads the app makes itself are filtered out by ignoreSelf.
 */
export async function evidenceTrigger(event: unknown): Promise<void> {
  try {
    const attachmentId = str(at(event, ['attachment', 'id']));
    const issueId = str(at(event, ['attachment', 'issueId'])) ?? str(at(event, ['issue', 'id'])) ?? str(at(event, ['attachment', 'issue', 'id']));
    if (attachmentId === null || issueId === null) {
      const keys = (v: unknown) => (v !== null && typeof v === 'object' ? Object.keys(v as object).join(',') : typeof v);
      console.log(`evidence trigger skipped: ids not found event=${keys(event)} attachment=${keys(at(event, ['attachment']))}`);
      return;
    }
    await ensureSchema();
    const obligation = await repo.findObligationByWorkItem(issueId);
    if (obligation === null || !DOCUMENT_KINDS.has(obligation.rule.kind)) return;
    const result = await startEvidenceCheck(issueId, attachmentId, {
      accountId: null,
      source: 'attachment',
      requester: asApp(),
    });
    console.log(`evidence trigger obligation=${obligation.id} status=${result.status}`);
  } catch (error) {
    // A trigger that throws is retried; a file Covenant cannot check is not worth retrying, and the panel offers Check.
    console.error(`evidence trigger failed error=${loggableError(error)}`);
  }
}

/** Whether this contract came from the sample workspace, so the panel may offer invented certificates to try the check with. */
async function isSampleContract(contract: repo.ContractRow): Promise<boolean> {
  const sample = await getJson<SampleStatus>(SAMPLE_WORKSPACE);
  return sample?.contracts.some((c) => c.key === contract.issueKey) ?? false;
}

/**
 * For the sample workspace only: a person's click attaches an invented
 * certificate to the obligation's work item, as that person, and checks it.
 * "valid" should pass; "problems" names another company, has a lower limit and
 * runs out too soon, so it should fail with a chase draft.
 */
export async function attachSampleCertificate(issueId: string, variant: 'valid' | 'problems', accountId: string): Promise<{ status: string; checkId: string | null; fileName: string }> {
  await ensureSchema();
  const obligation = await repo.findObligationByWorkItem(issueId);
  if (obligation === null || obligation.rule.kind !== 'audit_insurance') throw new UserFacingError('Sample certificates are for the insurance obligation of a sample contract.');
  const b = await bundleFor(obligation);
  if (!(await isSampleContract(b.contract))) throw new UserFacingError('Sample certificates are only offered for contracts loaded by the sample workspace.');
  const today = todayUtc();
  const expected = await expectedPartyOf(b);
  const cert = sampleCertificates(expected?.name ?? b.obligation.rule.responsibleParty, today, requiredUntilOf(b, today))[variant];
  const bytes = await buildContractDocx(cert.title, cert.sections);
  const issue = await getIssue(asUser(), issueId);
  const attachmentId = await uploadAttachment(asUser(), issue.key, cert.fileName, DOCX_TYPE, bytes);
  const result = await startEvidenceCheck(issueId, attachmentId, { accountId, source: 'panel', requester: asUser() });
  console.log(`evidence sample certificate attached obligation=${obligation.id} variant=${variant} status=${result.status}`);
  return { ...result, fileName: cert.fileName };
}

export async function offersSampleCertificates(obligation: repo.ObligationRow, contract: repo.ContractRow): Promise<boolean> {
  return obligation.rule.kind === 'audit_insurance' && (await isSampleContract(contract));
}
