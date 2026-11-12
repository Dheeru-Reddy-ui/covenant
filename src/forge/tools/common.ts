import { type ToolParse, clauseLocation } from '../../../packages/core/src';
import type { ClauseView } from '../../shared/panel';
import * as repo from '../db/repo';
import { UserFacingError, loggableError, readableError } from '../errors';
import { type IssueHeader, asUser, issueHeader } from '../jira';

/**
 * Plumbing shared by the four Rovo and MCP tools: who is calling, input
 * errors a model can fix, replies in one shape, and the pieces every answer
 * cites. Tools run as the caller, so Jira decides what they can see.
 */

export interface ToolCaller {
  accountId: string;
  /** For Teamwork Graph ids. Null when the platform did not say. */
  cloudId: string | null;
}

const pick = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Spike S4: over MCP the caller is context.principal.accountId; the Rovo docs
 * put it at context.accountId. Never read it from the payload, which a model
 * fills in. The site id comes from the install context first.
 */
export function toolCaller(payload: unknown, context: unknown): ToolCaller {
  const accountId = nonEmpty(pick(context, ['principal', 'accountId'])) ?? nonEmpty(pick(context, ['accountId']));
  if (accountId === null) throw new UserFacingError('Covenant could not tell who is calling, so it returned nothing. Sign in and try again.');
  const install = nonEmpty(pick(context, ['installContext']));
  const fromInstall = install ? (/^ari:cloud:[a-z]+::site\/([0-9a-f-]+)$/.exec(install)?.[1] ?? null) : null;
  return { accountId, cloudId: fromInstall ?? nonEmpty(pick(payload, ['context', 'cloudId'])) };
}

export class ToolInputError extends Error {
  override name = 'ToolInputError';
  constructor(readonly problems: string[]) {
    super('invalid tool input');
  }
}

export function expectInput<T>(parsed: ToolParse<T>): T {
  if (!parsed.ok) throw new ToolInputError(parsed.problems);
  return parsed.value;
}

export interface ToolResult {
  data: Record<string, unknown>;
  /** Counts and flags for the log line. Never text from a contract. */
  counts?: Record<string, number | boolean | string>;
}

export type ToolReply = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string; problems?: string[] };

/** Runs a tool and always answers: { ok: true, ... } or { ok: false, error } in words a model can pass on. */
export async function runTool(name: string, payload: unknown, context: unknown, run: (caller: ToolCaller) => Promise<ToolResult>): Promise<ToolReply> {
  const started = Date.now();
  try {
    const caller = toolCaller(payload, context);
    const { data, counts = {} } = await run(caller);
    const extra = Object.entries(counts)
      .map(([k, v]) => ` ${k}=${v}`)
      .join('');
    console.log(`tool ${name} ${data.ok === false ? 'refused' : 'ok'}${extra} ms=${Date.now() - started}`);
    return { ok: true, ...data };
  } catch (error) {
    if (error instanceof ToolInputError) {
      console.log(`tool ${name} refused input problems=${error.problems.length} ms=${Date.now() - started}`);
      return { ok: false, error: 'The input was not valid. Fix the problems listed and call again.', problems: error.problems };
    }
    console.error(`tool ${name} failed error=${loggableError(error)} ms=${Date.now() - started}`);
    return { ok: false, error: readableError(error, 'Covenant could not complete this request') };
  }
}

export const browseUrl = (base: string | null, key: string | null): string | null => (base !== null && key !== null ? `${base}/browse/${key}` : null);

export const isoDay = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

export function contractOut(contract: repo.ContractRow, issue: IssueHeader, base: string | null) {
  return { workItem: issue.key, title: issue.summary, file: contract.fileName, contractId: contract.id, url: browseUrl(base, issue.key) };
}

export function citationOut(clause: repo.ClauseRow, paginated: boolean) {
  return {
    quote: clause.quote,
    location: clauseLocation({ page: clause.page, pageEnd: clause.pageEnd, paginated, section: clause.section }),
    /** The numbered clause the quote sits in, found by code: "1.2", "Section 5". Null when the contract does not number it nearby. */
    clause: clause.section ? (clause.section.label === 'clause' ? clause.section.number : `${clause.section.label} ${clause.section.number}`) : null,
    clauseHeading: clause.section?.heading ?? null,
    page: paginated ? clause.page : null,
    pageEnd: paginated ? clause.pageEnd : null,
    /** The same words appear elsewhere and Covenant could not tell which one is meant, so the page may be another occurrence. */
    pageUncertain: clause.ambiguous,
  };
}

/** The same wording as clauseLocation, for a clause the brief has already shaped for display. */
export function viewLocation(c: ClauseView): string {
  const pages = c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
  if (c.section) return `${c.section}, ${c.paginated ? pages : 'Word file'}`;
  return c.paginated ? pages : 'Word file (no page numbers)';
}

export type ReviewState = 'approved' | 'awaiting_review' | 'flagged';

/** approved: a person approved it. awaiting_review: nobody has yet. flagged: the extractor's two readings disagreed or it was unsure. */
export function reviewOf(o: repo.ObligationRow): ReviewState {
  if (o.decision === 'approved' || o.decision === 'approving') return 'approved';
  return o.extractorStatus === 'needs_review' ? 'flagged' : 'awaiting_review';
}

const notFound = (key: string) => new UserFacingError(`No extracted contract was found on ${key}, or you cannot see that work item.`);

/**
 * The contract a tool was pointed at, after Jira confirms the caller can see
 * its work item. A hidden work item and a missing one get the same answer.
 */
export async function contractFor(issueKey: string, contractId: string | null): Promise<{ contract: repo.ContractRow; issue: IssueHeader }> {
  const issue = await issueHeader(asUser(), issueKey);
  if (issue === null) throw notFound(issueKey);
  const contracts = await repo.listContractsForIssue(issue.id);
  if (contracts.length === 0) throw notFound(issue.key);
  if (contractId !== null) {
    const contract = contracts.find((c) => c.id === contractId);
    if (contract === undefined) {
      throw new UserFacingError(`${issue.key} has no contract with id ${contractId}. Its contracts: ${contracts.map((c) => `${c.id} (${c.fileName})`).join('; ')}.`);
    }
    return { contract, issue };
  }
  if (contracts.length > 1) {
    throw new UserFacingError(
      `${issue.key} holds ${contracts.length} contracts. Call again with contractId set to one of: ${contracts.map((c) => `${c.id} (${c.fileName})`).join('; ')}.`,
    );
  }
  return { contract: contracts[0] as repo.ContractRow, issue };
}
