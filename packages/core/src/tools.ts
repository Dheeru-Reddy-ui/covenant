import { DECISION_OUTCOMES, type DecisionOutcome, parseDecisionInput } from './decision';
import type { IsoDate } from './dates/civil';
import { type RegisterItem, type RegisterRow, registerRows } from './register';
import { OBLIGATION_KINDS, type ObligationKind } from './schema';
import { type ClauseSection, describeSection } from './sections';

/**
 * Input rules for the four tools Covenant exposes to Rovo and MCP clients.
 *
 * The caller is a model, so inputs arrive loosely typed: numbers as text,
 * blank strings for "not set", kinds in everyday words, and envelope keys the
 * platform adds. Everything here either reads the input exactly or says what
 * it expected. Nothing is guessed: an unknown kind or outcome is an error, not
 * the nearest match.
 */

export const TOOL_DEFAULT_LIMIT = 25;
export const TOOL_MAX_LIMIT = 100;
export const TOOL_MAX_WINDOW_DAYS = 730;
const MAX_TEXT = 120;
const MAX_ID = 64;

export type ToolParse<T> = { ok: true; value: T } | { ok: false; problems: string[] };

type Raw = Record<string, unknown>;

const record = (raw: unknown): Raw => (raw !== null && typeof raw === 'object' ? (raw as Raw) : {});

/** A trimmed string, or null when absent or blank. Anything else is a problem. */
function text(raw: Raw, name: string, problems: string[], max = MAX_TEXT): string | null {
  const value = raw[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push(`${name}: expected text`);
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    problems.push(`${name}: at most ${max} characters`);
    return null;
  }
  return trimmed;
}

/** A whole number in range, accepting digits sent as text. */
function wholeNumber(raw: Raw, name: string, min: number, max: number, problems: string[]): number | null {
  const value = raw[name];
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name}: expected a whole number from ${min} to ${max}`);
    return null;
  }
  return n;
}

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

// Every key is normalised. Kind ids and the labels Covenant shows are included.
const KIND_WORDS: Record<string, ObligationKind> = {
  renewal_notice: 'renewal_notice',
  renewal: 'renewal_notice',
  renewals: 'renewal_notice',
  notice: 'renewal_notice',
  notices: 'renewal_notice',
  notice_deadline: 'renewal_notice',
  notice_deadlines: 'renewal_notice',
  termination: 'renewal_notice',
  termination_notice: 'renewal_notice',
  non_renewal: 'renewal_notice',
  payment: 'payment',
  payments: 'payment',
  invoice: 'payment',
  invoices: 'payment',
  fee: 'payment',
  fees: 'payment',
  price_change: 'price_change',
  price_changes: 'price_change',
  price: 'price_change',
  price_increase: 'price_change',
  reporting_deliverable: 'reporting_deliverable',
  report_or_deliverable: 'reporting_deliverable',
  report: 'reporting_deliverable',
  reports: 'reporting_deliverable',
  reporting: 'reporting_deliverable',
  deliverable: 'reporting_deliverable',
  deliverables: 'reporting_deliverable',
  audit_insurance: 'audit_insurance',
  audit_or_insurance: 'audit_insurance',
  audit: 'audit_insurance',
  insurance: 'audit_insurance',
  service_credit: 'service_credit',
  service_credits: 'service_credit',
  sla: 'service_credit',
  credit: 'service_credit',
  credits: 'service_credit',
};

/** Kinds from a comma- or semicolon-separated list, in the order given, without repeats. */
export function parseKinds(input: string): ToolParse<ObligationKind[]> {
  const kinds: ObligationKind[] = [];
  const unknown: string[] = [];
  for (const part of input.split(/[,;]/)) {
    const word = part.trim();
    if (word === '') continue;
    const kind = KIND_WORDS[normalise(word)];
    if (kind === undefined) unknown.push(word);
    else if (!kinds.includes(kind)) kinds.push(kind);
  }
  if (unknown.length > 0) {
    return { ok: false, problems: [`kind: unknown ${unknown.map((u) => `"${u}"`).join(', ')}; use one or more of ${OBLIGATION_KINDS.join(', ')}`] };
  }
  return { ok: true, value: kinds };
}

export type ToolStatusFilter = 'open' | 'needs_review' | 'approved';

const STATUS_WORDS: Record<string, ToolStatusFilter> = {
  open: 'open',
  all: 'open',
  any: 'open',
  needs_review: 'needs_review',
  awaiting_review: 'needs_review',
  pending: 'needs_review',
  unreviewed: 'needs_review',
  approved: 'approved',
  reviewed: 'approved',
};

export interface ListObligationsQuery {
  /** Only obligations due from today to this many days ahead. Null lists everything, overdue and undated included. */
  withinDays: number | null;
  kinds: ObligationKind[] | null;
  /** Text matched against the contract's work item key, title and file name. */
  contract: string | null;
  /** Text matched against the party the clause makes responsible. */
  party: string | null;
  status: ToolStatusFilter;
  limit: number;
}

export function parseListObligationsInput(input: unknown): ToolParse<ListObligationsQuery> {
  const raw = record(input);
  const problems: string[] = [];
  const withinDays = wholeNumber(raw, 'withinDays', 1, TOOL_MAX_WINDOW_DAYS, problems);
  const kindText = text(raw, 'kind', problems, 300);
  let kinds: ObligationKind[] | null = null;
  if (kindText !== null) {
    const parsed = parseKinds(kindText);
    if (parsed.ok) kinds = parsed.value.length > 0 ? parsed.value : null;
    else problems.push(...parsed.problems);
  }
  const contract = text(raw, 'contract', problems);
  const party = text(raw, 'party', problems);
  const statusText = text(raw, 'status', problems);
  let status: ToolStatusFilter = 'open';
  if (statusText !== null) {
    const found = STATUS_WORDS[normalise(statusText)];
    if (found === undefined) problems.push(`status: unknown "${statusText}"; use open, needs_review or approved`);
    else status = found;
  }
  const limit = wholeNumber(raw, 'limit', 1, TOOL_MAX_LIMIT, problems) ?? TOOL_DEFAULT_LIMIT;
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { withinDays, kinds, contract, party, status, limit } };
}

export interface ToolItem extends RegisterItem {
  kind: ObligationKind;
  party: string;
  /** The contract's work item key, title and file name, for the contract filter. */
  contractNames: readonly string[];
}

export interface ToolSelection<T extends ToolItem> {
  rows: Array<RegisterRow<T>>;
  /** How many matched before the limit. */
  total: number;
  truncated: boolean;
}

const contains = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());

const statusMatches = (decision: RegisterItem['decision'], status: ToolStatusFilter): boolean => {
  if (status === 'needs_review') return decision === 'pending' || decision === 'edited';
  if (status === 'approved') return decision === 'approved' || decision === 'approving';
  return true;
};

/** Filters and orders obligations the way the register does. Rejected obligations never appear. */
export function selectObligations<T extends ToolItem>(
  items: readonly T[],
  query: ListObligationsQuery,
  options: { today: IsoDate; noticeLeadDays: number },
): ToolSelection<T> {
  const matched = registerRows(
    items.filter(
      (item) =>
        (query.kinds === null || query.kinds.includes(item.kind)) &&
        (query.contract === null || item.contractNames.some((name) => contains(name, query.contract as string))) &&
        (query.party === null || contains(item.party, query.party)) &&
        statusMatches(item.decision, query.status),
    ),
    { today: options.today, windowDays: query.withinDays, noticeLeadDays: options.noticeLeadDays },
  );
  return { rows: matched.slice(0, query.limit), total: matched.length, truncated: matched.length > query.limit };
}

// "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "UTC". Whether the zone exists is checked where the clock is read.
const TIME_ZONE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/** The caller's time zone, so "today" and days left follow their calendar. Null means UTC. */
export function parseTimeZone(input: unknown): ToolParse<string | null> {
  const raw = record(input);
  const problems: string[] = [];
  const zone = text(raw, 'timeZone', problems, 64);
  if (problems.length > 0) return { ok: false, problems };
  if (zone !== null && !TIME_ZONE.test(zone)) {
    return { ok: false, problems: ['timeZone: expected an IANA time zone name such as Europe/London or Asia/Kolkata'] };
  }
  return { ok: true, value: zone };
}

export interface ContractRef {
  issueKey: string;
  /** Needed only when the work item holds more than one contract. */
  contractId: string | null;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const BROWSE_KEY = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/;

function issueKeyOf(raw: Raw, problems: string[]): string | null {
  const value = typeof raw.contract === 'string' ? raw.contract.trim().slice(0, 500) : '';
  const key = (BROWSE_KEY.exec(value)?.[1] ?? value).toUpperCase();
  if (!ISSUE_KEY.test(key)) {
    problems.push('contract: expected the work item key the contract is attached to, such as ABC-123');
    return null;
  }
  return key;
}

function idOf(raw: Raw, name: string, problems: string[], required: boolean): string | null {
  const value = text(raw, name, problems, MAX_ID);
  if (value === null && required && !problems.some((p) => p.startsWith(`${name}:`))) problems.push(`${name}: required`);
  return value;
}

export function parseContractRef(input: unknown): ToolParse<ContractRef> {
  const raw = record(input);
  const problems: string[] = [];
  const issueKey = issueKeyOf(raw, problems);
  const contractId = idOf(raw, 'contractId', problems, false);
  if (problems.length > 0 || issueKey === null) return { ok: false, problems };
  return { ok: true, value: { issueKey, contractId } };
}

export function parseObligationRef(input: unknown): ToolParse<{ obligationId: string }> {
  const raw = record(input);
  const problems: string[] = [];
  const obligationId = idOf(raw, 'obligationId', problems, true);
  if (problems.length > 0 || obligationId === null) return { ok: false, problems };
  return { ok: true, value: { obligationId } };
}

export interface RecordDecisionRequest extends ContractRef {
  outcome: DecisionOutcome;
  rationale: string;
  /** True only when the caller sent confirm: true. Anything else is a request to preview. */
  confirmed: boolean;
}

export function parseRecordDecisionInput(input: unknown): ToolParse<RecordDecisionRequest> {
  const raw = record(input);
  const problems: string[] = [];
  const issueKey = issueKeyOf(raw, problems);
  const contractId = idOf(raw, 'contractId', problems, false);
  const outcomeText = text(raw, 'outcome', problems);
  const outcome = outcomeText?.toLowerCase() ?? '';
  if (!(DECISION_OUTCOMES as readonly string[]).includes(outcome)) {
    problems.push(`outcome: expected one of ${DECISION_OUTCOMES.join(', ')}`);
  }
  const decision = parseDecisionInput({ outcome: DECISION_OUTCOMES[0], rationale: typeof raw.rationale === 'string' ? raw.rationale : '' });
  if (!decision.ok) problems.push(...decision.problems);
  const confirm = raw.confirm;
  const confirmed = confirm === true || (typeof confirm === 'string' && confirm.trim().toLowerCase() === 'true');
  if (problems.length > 0 || issueKey === null || !decision.ok) return { ok: false, problems };
  return { ok: true, value: { issueKey, contractId, outcome: outcome as DecisionOutcome, rationale: decision.value.rationale, confirmed } };
}

/** Where a quote sits in its file, in words: the clause when code found one, then the page. Word files have no fixed pages. */
export function clauseLocation(clause: { page: number; pageEnd: number; paginated: boolean; section?: ClauseSection | null }): string {
  const pages = clause.page === clause.pageEnd ? `page ${clause.page}` : `pages ${clause.page} to ${clause.pageEnd}`;
  if (clause.section) return `${describeSection(clause.section)}, ${clause.paginated ? pages : 'Word file'}`;
  return clause.paginated ? pages : 'Word file (no page numbers)';
}
