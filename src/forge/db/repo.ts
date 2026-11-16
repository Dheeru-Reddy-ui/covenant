import { type UpdateQueryResponse, sql } from '@forge/sql';
import { type HolidayList, WEEKENDS_ONLY, readHolidayList } from '../../../packages/core/src';
import type {
  ClauseSection,
  DetailKind,
  ContractTerms,
  FactStatus,
  IsoDate,
  ObligationDecision,
  ObligationRule,
  RenewalValue,
  ReviewNote,
  TermValue,
} from '../../../packages/core/src';

/**
 * Typed access to Forge SQL. One statement per call, `?` parameters only.
 * Rows hold contract text (quotes); nothing here logs.
 */

export type RunStatus = 'queued' | 'running' | 'needs_review' | 'approved' | 'failed';
export type ScheduleStatus = 'upcoming' | 'past' | 'undated';

export interface ContractRow {
  id: string;
  issueId: string;
  issueKey: string;
  projectId: string;
  attachmentId: string;
  sha256: string;
  fileName: string;
  fileKind: string;
  byteLength: number;
  termIndex: number;
  createdBy: string;
  createdAtMs: number;
  /** The contract's holiday list, from contract_setting. Weekends only until a person sets one. */
  holidays: HolidayList;
}

export type FactState = 'ready' | 'needs_review' | 'missing' | 'edited';

export interface StoredFact<V> {
  status: FactState;
  value: V | null;
  clauseId: string | null;
  confidence: string | null;
  review: ReviewNote[];
  /** The critic's reading when it differed, as the model gave it. */
  secondReading: unknown;
}

export interface StoredFacts {
  effectiveDate: StoredFact<IsoDate>;
  term: StoredFact<TermValue>;
  renewal: StoredFact<RenewalValue>;
  editedBy: string | null;
  editedAtMs: number | null;
}

export interface RunRow {
  id: string;
  contractId: string;
  extractorVersion: number;
  schemaVersion: number;
  model: string;
  status: RunStatus;
  jobId: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  secondPasses: number;
  repaired: boolean;
  quotesReturned: number;
  quotesVerified: number;
  rejectedCount: number;
  pages: number | null;
  chars: number | null;
  paginated: boolean;
  facts: StoredFacts | null;
  terms: ContractTerms | null;
  autoRenew: boolean;
  requestedBy: string;
  queuedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  updatedAtMs: number;
}

export interface ClauseRow {
  id: string;
  runId: string;
  contractId: string;
  role: 'effective_date' | 'term' | 'renewal' | 'obligation';
  quote: string;
  page: number;
  pageEnd: number;
  startOffset: number;
  endOffset: number;
  occurrences: number;
  ambiguous: boolean;
  /** The numbered clause the quote sits in, found by code. Null when none was found or not yet looked for. */
  section: ClauseSection | null;
}

export interface ObligationRow {
  id: string;
  runId: string;
  contractId: string;
  clauseId: string;
  ordinal: number;
  rule: ObligationRule;
  originalRule: ObligationRule;
  secondRule: ObligationRule | null;
  extractorStatus: FactStatus;
  review: ReviewNote[];
  decision: ObligationDecision;
  eventDate: IsoDate | null;
  dueDate: IsoDate | null;
  scheduleStatus: ScheduleStatus;
  workItemId: string | null;
  workItemKey: string | null;
  lastError: string | null;
  decidedBy: string | null;
  decidedAtMs: number | null;
  updatedAtMs: number;
}

type Raw = Record<string, unknown>;

async function select(query: string, ...params: unknown[]): Promise<Raw[]> {
  const result = await sql.prepare<Raw>(query).bindParams(...params).execute();
  return Array.isArray(result.rows) ? result.rows : [];
}

/** Runs an INSERT, UPDATE or DELETE and returns how many rows it changed. */
async function change(query: string, ...params: unknown[]): Promise<number> {
  const result = await sql.prepare<UpdateQueryResponse>(query).bindParams(...params).execute();
  return Number(result.rows.affectedRows ?? 0);
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dateOrNull = (v: unknown): IsoDate | null => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 10));
const bool = (v: unknown): boolean => v === true || Number(v) === 1;
const json = <T>(v: unknown): T | null => (v === null || v === undefined || v === '' ? null : (JSON.parse(String(v)) as T));

// ---- contract ----

const CONTRACT_COLUMNS =
  'id, issue_id, issue_key, project_id, attachment_id, attachment_sha256, file_name, file_kind, byte_length, term_index, created_by, created_at_ms';

// Every read brings the contract's holiday list with it, so no date is ever worked out without it.
const CONTRACT_SELECT =
  'SELECT c.id, c.issue_id, c.issue_key, c.project_id, c.attachment_id, c.attachment_sha256, c.file_name, c.file_kind, c.byte_length, c.term_index, ' +
  "c.created_by, c.created_at_ms, cal.value AS calendar_json FROM contract c LEFT JOIN contract_setting cal ON cal.contract_id = c.id AND cal.name = 'calendar'";

function storedHolidays(v: unknown): HolidayList {
  try {
    return readHolidayList(json<unknown>(v));
  } catch {
    return WEEKENDS_ONLY;
  }
}

const toContract = (r: Raw): ContractRow => ({
  id: String(r.id),
  issueId: String(r.issue_id),
  issueKey: String(r.issue_key),
  projectId: String(r.project_id),
  attachmentId: String(r.attachment_id),
  sha256: String(r.attachment_sha256),
  fileName: String(r.file_name),
  fileKind: String(r.file_kind),
  byteLength: num(r.byte_length),
  termIndex: num(r.term_index),
  createdBy: String(r.created_by),
  createdAtMs: num(r.created_at_ms),
  holidays: storedHolidays(r.calendar_json),
});

/** Inserts unless this file is already a contract on this work item. Returns whether a row was added. */
export async function insertContractIfNew(c: ContractRow): Promise<boolean> {
  const added = await change(
    `INSERT IGNORE INTO contract (${CONTRACT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id,
    c.issueId,
    c.issueKey,
    c.projectId,
    c.attachmentId,
    c.sha256,
    c.fileName,
    c.fileKind,
    c.byteLength,
    c.termIndex,
    c.createdBy,
    c.createdAtMs,
  );
  return added === 1;
}

export async function findContract(issueId: string, sha256: string): Promise<ContractRow | null> {
  const rows = await select(`${CONTRACT_SELECT} WHERE c.issue_id = ? AND c.attachment_sha256 = ?`, issueId, sha256);
  return rows[0] ? toContract(rows[0]) : null;
}

export async function getContract(id: string): Promise<ContractRow | null> {
  const rows = await select(`${CONTRACT_SELECT} WHERE c.id = ?`, id);
  return rows[0] ? toContract(rows[0]) : null;
}

export async function setContractAttachment(id: string, attachmentId: string): Promise<void> {
  await change('UPDATE contract SET attachment_id = ? WHERE id = ?', attachmentId, id);
}

export async function listContractsForIssue(issueId: string): Promise<ContractRow[]> {
  const rows = await select(`${CONTRACT_SELECT} WHERE c.issue_id = ? ORDER BY c.created_at_ms DESC LIMIT 20`, issueId);
  return rows.map(toContract);
}

// ---- extraction_run ----

const RUN_COLUMNS =
  'id, contract_id, extractor_version, schema_version, model, status, job_id, attempts, error_code, error_message, input_tokens, output_tokens, ' +
  'llm_calls, second_passes, repaired, quotes_returned, quotes_verified, rejected_count, pages, chars, paginated, facts_json, terms_json, ' +
  'auto_renew, requested_by, queued_at_ms, started_at_ms, finished_at_ms, updated_at_ms';

const toRun = (r: Raw): RunRow => ({
  id: String(r.id),
  contractId: String(r.contract_id),
  extractorVersion: num(r.extractor_version),
  schemaVersion: num(r.schema_version),
  model: String(r.model),
  status: String(r.status) as RunStatus,
  jobId: strOrNull(r.job_id),
  attempts: num(r.attempts),
  errorCode: strOrNull(r.error_code),
  errorMessage: strOrNull(r.error_message),
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  llmCalls: num(r.llm_calls),
  secondPasses: num(r.second_passes),
  repaired: bool(r.repaired),
  quotesReturned: num(r.quotes_returned),
  quotesVerified: num(r.quotes_verified),
  rejectedCount: num(r.rejected_count),
  pages: numOrNull(r.pages),
  chars: numOrNull(r.chars),
  paginated: bool(r.paginated),
  facts: json<StoredFacts>(r.facts_json),
  terms: json<ContractTerms>(r.terms_json),
  autoRenew: bool(r.auto_renew),
  requestedBy: String(r.requested_by),
  queuedAtMs: num(r.queued_at_ms),
  startedAtMs: numOrNull(r.started_at_ms),
  finishedAtMs: numOrNull(r.finished_at_ms),
  updatedAtMs: num(r.updated_at_ms),
});

export interface NewRun {
  id: string;
  contractId: string;
  extractorVersion: number;
  schemaVersion: number;
  model: string;
  requestedBy: string;
  nowMs: number;
}

/** Inserts a queued run unless this contract already has one for this extractor version. Returns whether a row was added. */
export async function insertRunIfNew(r: NewRun): Promise<boolean> {
  const added = await change(
    'INSERT IGNORE INTO extraction_run (id, contract_id, extractor_version, schema_version, model, status, requested_by, queued_at_ms, updated_at_ms) ' +
      "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
    r.id,
    r.contractId,
    r.extractorVersion,
    r.schemaVersion,
    r.model,
    r.requestedBy,
    r.nowMs,
    r.nowMs,
  );
  return added === 1;
}

export async function findRun(contractId: string, extractorVersion: number): Promise<RunRow | null> {
  const rows = await select(`SELECT ${RUN_COLUMNS} FROM extraction_run WHERE contract_id = ? AND extractor_version = ?`, contractId, extractorVersion);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function getRun(id: string): Promise<RunRow | null> {
  const rows = await select(`SELECT ${RUN_COLUMNS} FROM extraction_run WHERE id = ?`, id);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function latestRun(contractId: string): Promise<RunRow | null> {
  const rows = await select(`SELECT ${RUN_COLUMNS} FROM extraction_run WHERE contract_id = ? ORDER BY extractor_version DESC LIMIT 1`, contractId);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function setRunJob(id: string, jobId: string): Promise<void> {
  await change('UPDATE extraction_run SET job_id = ? WHERE id = ?', jobId, id);
}

/**
 * Moves a failed run, or one lost while queued or running since before
 * `staleBeforeMs`, back to queued. Returns whether it moved.
 */
export async function requeueRun(id: string, requestedBy: string, nowMs: number, staleBeforeMs: number): Promise<boolean> {
  const moved = await change(
    "UPDATE extraction_run SET status = 'queued', error_code = NULL, error_message = NULL, requested_by = ?, queued_at_ms = ?, " +
      'started_at_ms = NULL, finished_at_ms = NULL, updated_at_ms = ? ' +
      "WHERE id = ? AND (status = 'failed' OR (status = 'running' AND started_at_ms < ?) OR (status = 'queued' AND queued_at_ms < ?))",
    requestedBy,
    nowMs,
    nowMs,
    id,
    staleBeforeMs,
    staleBeforeMs,
  );
  return moved === 1;
}

/** The worker's claim on a queued run. Only one delivery of the event can win it. */
export async function claimRun(id: string, nowMs: number): Promise<boolean> {
  const won = await change(
    "UPDATE extraction_run SET status = 'running', attempts = attempts + 1, started_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status = 'queued'",
    nowMs,
    nowMs,
    id,
  );
  return won === 1;
}

export interface RunMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  secondPasses: number;
  repaired: boolean;
  quotesReturned: number;
  quotesVerified: number;
  rejectedCount: number;
  pages: number | null;
  chars: number | null;
  paginated: boolean | null;
}

export async function failRun(id: string, code: string, message: string, metrics: Partial<RunMetrics>, nowMs: number): Promise<void> {
  await change(
    "UPDATE extraction_run SET status = 'failed', error_code = ?, error_message = ?, input_tokens = ?, output_tokens = ?, llm_calls = ?, " +
      'pages = ?, chars = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?',
    code,
    message.slice(0, 1000),
    metrics.inputTokens ?? 0,
    metrics.outputTokens ?? 0,
    metrics.llmCalls ?? 0,
    metrics.pages ?? null,
    metrics.chars ?? null,
    nowMs,
    nowMs,
    id,
  );
}

export async function completeRun(
  id: string,
  metrics: RunMetrics,
  facts: StoredFacts,
  terms: ContractTerms,
  autoRenew: boolean,
  nowMs: number,
): Promise<void> {
  await change(
    "UPDATE extraction_run SET status = 'needs_review', error_code = NULL, error_message = NULL, model = ?, input_tokens = ?, output_tokens = ?, " +
      'llm_calls = ?, second_passes = ?, repaired = ?, quotes_returned = ?, quotes_verified = ?, rejected_count = ?, pages = ?, chars = ?, ' +
      'paginated = ?, facts_json = ?, terms_json = ?, auto_renew = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?',
    metrics.model,
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.llmCalls,
    metrics.secondPasses,
    metrics.repaired ? 1 : 0,
    metrics.quotesReturned,
    metrics.quotesVerified,
    metrics.rejectedCount,
    metrics.pages,
    metrics.chars,
    metrics.paginated === null ? null : metrics.paginated ? 1 : 0,
    JSON.stringify(facts),
    JSON.stringify(terms),
    autoRenew ? 1 : 0,
    nowMs,
    nowMs,
    id,
  );
}

/** needs_review and approved move back and forth as obligations are decided; queued, running and failed are the worker's. */
export async function setReviewStatus(id: string, status: 'needs_review' | 'approved', nowMs: number): Promise<void> {
  await change(
    "UPDATE extraction_run SET status = ?, updated_at_ms = ? WHERE id = ? AND status IN ('needs_review', 'approved')",
    status,
    nowMs,
    id,
  );
}

export async function updateRunTerms(id: string, facts: StoredFacts, terms: ContractTerms, autoRenew: boolean, nowMs: number): Promise<void> {
  await change(
    'UPDATE extraction_run SET facts_json = ?, terms_json = ?, auto_renew = ?, updated_at_ms = ? WHERE id = ?',
    JSON.stringify(facts),
    JSON.stringify(terms),
    autoRenew ? 1 : 0,
    nowMs,
    id,
  );
}

// ---- clause ----

const CLAUSE_COLUMNS = 'id, run_id, contract_id, role, quote, page, page_end, start_offset, end_offset, occurrences, ambiguous';

// Every read joins the clause's section, when code has found one.
const CLAUSE_SELECT =
  'SELECT c.id, c.run_id, c.contract_id, c.role, c.quote, c.page, c.page_end, c.start_offset, c.end_offset, c.occurrences, c.ambiguous, ' +
  's.label AS section_label, s.clause_number AS section_number, s.heading AS section_heading ' +
  'FROM clause c LEFT JOIN clause_section s ON s.clause_id = c.id';

const SECTION_LABELS: ReadonlySet<string> = new Set(['clause', 'section', 'article']);

const toSection = (r: Raw): ClauseSection | null => {
  const label = strOrNull(r.section_label);
  const number = strOrNull(r.section_number);
  if (label === null || number === null || !SECTION_LABELS.has(label)) return null;
  return { label: label as ClauseSection['label'], number, heading: strOrNull(r.section_heading) };
};

const toClause = (r: Raw): ClauseRow => ({
  id: String(r.id),
  runId: String(r.run_id),
  contractId: String(r.contract_id),
  role: String(r.role) as ClauseRow['role'],
  quote: String(r.quote),
  page: num(r.page),
  pageEnd: num(r.page_end),
  startOffset: num(r.start_offset),
  endOffset: num(r.end_offset),
  occurrences: num(r.occurrences),
  ambiguous: bool(r.ambiguous),
  section: toSection(r),
});

/** Inserts the clause and, when given, the section code found for it (null: looked, found none). */
export async function insertClause(c: ClauseRow, section?: ClauseSection | null, nowMs = 0): Promise<void> {
  await change(
    `INSERT INTO clause (${CLAUSE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id,
    c.runId,
    c.contractId,
    c.role,
    c.quote,
    c.page,
    c.pageEnd,
    c.startOffset,
    c.endOffset,
    c.occurrences,
    c.ambiguous ? 1 : 0,
  );
  if (section !== undefined) await saveClauseSection(c.id, c.runId, section, nowMs);
}

export async function saveClauseSection(clauseId: string, runId: string, section: ClauseSection | null, nowMs: number): Promise<void> {
  await change(
    'INSERT IGNORE INTO clause_section (clause_id, run_id, label, clause_number, heading, found_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    clauseId,
    runId,
    section?.label ?? null,
    section?.number.slice(0, 32) ?? null,
    section?.heading?.slice(0, 120) ?? null,
    nowMs,
  );
}

/** Clauses from extractions made before Covenant found sections, oldest contracts first. */
export async function listClausesWithoutSection(limit: number): Promise<ClauseRow[]> {
  const rows = await select(`${CLAUSE_SELECT} WHERE s.clause_id IS NULL ORDER BY c.contract_id LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`);
  return rows.map(toClause);
}

export async function getClause(id: string): Promise<ClauseRow | null> {
  const rows = await select(`${CLAUSE_SELECT} WHERE c.id = ?`, id);
  return rows[0] ? toClause(rows[0]) : null;
}

export async function listClauses(runId: string): Promise<ClauseRow[]> {
  return (await select(`${CLAUSE_SELECT} WHERE c.run_id = ?`, runId)).map(toClause);
}

/** Clears what an earlier, interrupted attempt at this run left behind. */
export async function deleteRunContent(runId: string): Promise<void> {
  await change('DELETE FROM obligation WHERE run_id = ?', runId);
  await change('DELETE FROM clause_section WHERE run_id = ?', runId);
  await change('DELETE FROM clause WHERE run_id = ?', runId);
}

// ---- obligation ----

const OBLIGATION_COLUMNS =
  'id, run_id, contract_id, clause_id, ordinal, rule_json, original_rule_json, second_rule_json, extractor_status, review_json, decision, ' +
  'event_date, due_date, schedule_status, work_item_id, work_item_key, last_error, decided_by, decided_at_ms, updated_at_ms';

const toObligation = (r: Raw): ObligationRow => ({
  id: String(r.id),
  runId: String(r.run_id),
  contractId: String(r.contract_id),
  clauseId: String(r.clause_id),
  ordinal: num(r.ordinal),
  rule: json<ObligationRule>(r.rule_json) as ObligationRule,
  originalRule: json<ObligationRule>(r.original_rule_json) as ObligationRule,
  secondRule: json<ObligationRule>(r.second_rule_json),
  extractorStatus: String(r.extractor_status) as FactStatus,
  review: json<ReviewNote[]>(r.review_json) ?? [],
  decision: String(r.decision) as ObligationDecision,
  eventDate: dateOrNull(r.event_date),
  dueDate: dateOrNull(r.due_date),
  scheduleStatus: String(r.schedule_status) as ScheduleStatus,
  workItemId: strOrNull(r.work_item_id),
  workItemKey: strOrNull(r.work_item_key),
  lastError: strOrNull(r.last_error),
  decidedBy: strOrNull(r.decided_by),
  decidedAtMs: numOrNull(r.decided_at_ms),
  updatedAtMs: num(r.updated_at_ms),
});

export async function insertObligation(o: ObligationRow): Promise<void> {
  await change(
    'INSERT INTO obligation (id, run_id, contract_id, clause_id, ordinal, kind, responsible_party, summary, rule_json, original_rule_json, ' +
      'second_rule_json, confidence, extractor_status, review_json, decision, event_date, due_date, schedule_status, updated_at_ms) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    o.id,
    o.runId,
    o.contractId,
    o.clauseId,
    o.ordinal,
    o.rule.kind,
    o.rule.responsibleParty.slice(0, 120),
    o.rule.summary.slice(0, 300),
    JSON.stringify(o.rule),
    JSON.stringify(o.originalRule),
    o.secondRule === null ? null : JSON.stringify(o.secondRule),
    o.rule.confidence,
    o.extractorStatus,
    JSON.stringify(o.review),
    o.decision,
    o.eventDate,
    o.dueDate,
    o.scheduleStatus,
    o.updatedAtMs,
  );
}

export async function listObligations(runId: string): Promise<ObligationRow[]> {
  return (await select(`SELECT ${OBLIGATION_COLUMNS} FROM obligation WHERE run_id = ? ORDER BY ordinal`, runId)).map(toObligation);
}

export async function getObligation(id: string): Promise<ObligationRow | null> {
  const rows = await select(`SELECT ${OBLIGATION_COLUMNS} FROM obligation WHERE id = ?`, id);
  return rows[0] ? toObligation(rows[0]) : null;
}

export async function listDecisions(runId: string): Promise<ObligationDecision[]> {
  return (await select('SELECT decision FROM obligation WHERE run_id = ?', runId)).map((r) => String(r.decision) as ObligationDecision);
}

/**
 * Takes an obligation for approval so a double click cannot create two work
 * items. An 'approving' claim older than `staleBeforeMs` (a crash mid-create)
 * can be taken again.
 */
export async function claimForApproval(id: string, nowMs: number, staleBeforeMs: number): Promise<boolean> {
  const won = await change(
    "UPDATE obligation SET decision = 'approving', last_error = NULL, updated_at_ms = ? " +
      "WHERE id = ? AND (decision IN ('pending', 'edited') OR (decision = 'approving' AND updated_at_ms < ?))",
    nowMs,
    id,
    staleBeforeMs,
  );
  return won === 1;
}

export async function markApproved(
  id: string,
  workItem: { id: string; key: string },
  dueDate: IsoDate | null,
  scheduleStatus: ScheduleStatus,
  by: string,
  nowMs: number,
): Promise<void> {
  await change(
    "UPDATE obligation SET decision = 'approved', work_item_id = ?, work_item_key = ?, due_date = ?, schedule_status = ?, last_error = NULL, " +
      "decided_by = ?, decided_at_ms = ?, updated_at_ms = ? WHERE id = ? AND decision = 'approving'",
    workItem.id,
    workItem.key,
    dueDate,
    scheduleStatus,
    by,
    nowMs,
    nowMs,
    id,
  );
}

/** Gives back an approval claim that failed, with the reason the reviewer will see. */
export async function releaseApproval(id: string, backTo: 'pending' | 'edited', error: string, nowMs: number): Promise<void> {
  await change(
    "UPDATE obligation SET decision = ?, last_error = ?, updated_at_ms = ? WHERE id = ? AND decision = 'approving'",
    backTo,
    error.slice(0, 1000),
    nowMs,
    id,
  );
}

export async function rejectObligation(id: string, by: string, nowMs: number): Promise<boolean> {
  const done = await change(
    "UPDATE obligation SET decision = 'rejected', last_error = NULL, decided_by = ?, decided_at_ms = ?, updated_at_ms = ? " +
      "WHERE id = ? AND decision IN ('pending', 'edited')",
    by,
    nowMs,
    nowMs,
    id,
  );
  return done === 1;
}

/** Undoes a rejection. A rule that was edited before it was rejected comes back as edited. */
export async function reopenObligation(id: string, nowMs: number): Promise<boolean> {
  const done = await change(
    "UPDATE obligation SET decision = CASE WHEN rule_json = original_rule_json AND event_date IS NULL THEN 'pending' ELSE 'edited' END, " +
      "decided_by = NULL, decided_at_ms = NULL, updated_at_ms = ? WHERE id = ? AND decision = 'rejected'",
    nowMs,
    id,
  );
  return done === 1;
}

export async function saveEdit(
  id: string,
  rule: ObligationRule,
  eventDate: IsoDate | null,
  dueDate: IsoDate | null,
  scheduleStatus: ScheduleStatus,
  nowMs: number,
): Promise<boolean> {
  const done = await change(
    "UPDATE obligation SET rule_json = ?, kind = ?, responsible_party = ?, summary = ?, event_date = ?, due_date = ?, schedule_status = ?, " +
      "decision = 'edited', last_error = NULL, updated_at_ms = ? WHERE id = ? AND decision IN ('pending', 'edited')",
    JSON.stringify(rule),
    rule.kind,
    rule.responsibleParty.slice(0, 120),
    rule.summary.slice(0, 300),
    eventDate,
    dueDate,
    scheduleStatus,
    nowMs,
    id,
  );
  return done === 1;
}

/** Keeps the stored due date of an undecided obligation in step with edited term facts. */
export async function saveSchedule(id: string, dueDate: IsoDate | null, scheduleStatus: ScheduleStatus, nowMs: number): Promise<void> {
  await change(
    "UPDATE obligation SET due_date = ?, schedule_status = ?, updated_at_ms = ? WHERE id = ? AND decision IN ('pending', 'edited')",
    dueDate,
    scheduleStatus,
    nowMs,
    id,
  );
}

/** Approved obligations follow their work item: this records the due date after the item itself was moved. */
export async function saveApprovedDueDate(id: string, dueDate: IsoDate | null, scheduleStatus: ScheduleStatus, nowMs: number): Promise<void> {
  await change(
    "UPDATE obligation SET due_date = ?, schedule_status = ?, updated_at_ms = ? WHERE id = ? AND decision = 'approved'",
    dueDate,
    scheduleStatus,
    nowMs,
    id,
  );
}

// ---- portfolio ----

const PORTFOLIO_LIMIT = 500;

export async function listAllContracts(): Promise<ContractRow[]> {
  return (await select(`${CONTRACT_SELECT} ORDER BY c.created_at_ms DESC LIMIT ${PORTFOLIO_LIMIT}`)).map(toContract);
}

/** The newest finished run of every contract that has one. */
export async function listLatestReviewableRuns(): Promise<RunRow[]> {
  const rows = (await select(`SELECT ${RUN_COLUMNS} FROM extraction_run WHERE status IN ('needs_review', 'approved')`)).map(toRun);
  const latest = new Map<string, RunRow>();
  for (const run of rows) {
    const seen = latest.get(run.contractId);
    if (seen === undefined || run.extractorVersion > seen.extractorVersion) latest.set(run.contractId, run);
  }
  return [...latest.values()];
}

/** The status of the newest extraction run for each of these work items that has one, by work item key. */
export async function latestRunStatusByIssueKey(keys: readonly string[]): Promise<Map<string, RunStatus>> {
  const out = new Map<string, { status: RunStatus; version: number; at: number }>();
  if (keys.length === 0) return new Map();
  const rows = await select(
    `SELECT c.issue_key, r.status, r.extractor_version, c.created_at_ms FROM contract c JOIN extraction_run r ON r.contract_id = c.id WHERE c.issue_key IN (${marks(keys.length)})`,
    ...keys,
  );
  for (const row of rows) {
    const key = String(row.issue_key);
    const next = { status: String(row.status) as RunStatus, version: num(row.extractor_version), at: num(row.created_at_ms) };
    const seen = out.get(key);
    if (seen === undefined || next.at > seen.at || (next.at === seen.at && next.version > seen.version)) out.set(key, next);
  }
  return new Map([...out].map(([k, v]) => [k, v.status]));
}

async function inChunks<T>(ids: readonly string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await load(ids.slice(i, i + 100))));
  return out;
}

const marks = (n: number): string => new Array(n).fill('?').join(', ');

export async function listObligationsForRuns(runIds: readonly string[]): Promise<ObligationRow[]> {
  return inChunks(runIds, async (chunk) =>
    (await select(`SELECT ${OBLIGATION_COLUMNS} FROM obligation WHERE run_id IN (${marks(chunk.length)}) ORDER BY ordinal`, ...chunk)).map(toObligation),
  );
}

export async function listClausesForRuns(runIds: readonly string[]): Promise<ClauseRow[]> {
  return inChunks(runIds, async (chunk) =>
    (await select(`${CLAUSE_SELECT} WHERE c.run_id IN (${marks(chunk.length)})`, ...chunk)).map(toClause),
  );
}

/** Marks a contract renewed, or undoes it. Moves only from the term the reviewer saw, so two clicks cannot skip a term. */
export async function setTermIndex(contractId: string, from: number, to: number): Promise<boolean> {
  return (await change('UPDATE contract SET term_index = ? WHERE id = ? AND term_index = ?', to, contractId, from)) === 1;
}

// ---- contract_state ----

export interface ContractState {
  contractId: string;
  noticeDeadline: IsoDate | null;
  noticeStatus: string | null;
  windowCheckedAtMs: number | null;
  decisionItemKey: string | null;
  decisionItemTerm: number | null;
  decisionItemClaimedAtMs: number | null;
  renewedBy: string | null;
  renewedAtMs: number | null;
}

const STATE_COLUMNS =
  'contract_id, notice_deadline, notice_status, window_checked_at_ms, decision_item_key, decision_item_term, decision_item_claimed_at_ms, renewed_by, renewed_at_ms';

const toState = (r: Raw): ContractState => ({
  contractId: String(r.contract_id),
  noticeDeadline: dateOrNull(r.notice_deadline),
  noticeStatus: strOrNull(r.notice_status),
  windowCheckedAtMs: numOrNull(r.window_checked_at_ms),
  decisionItemKey: strOrNull(r.decision_item_key),
  decisionItemTerm: numOrNull(r.decision_item_term),
  decisionItemClaimedAtMs: numOrNull(r.decision_item_claimed_at_ms),
  renewedBy: strOrNull(r.renewed_by),
  renewedAtMs: numOrNull(r.renewed_at_ms),
});

export const emptyContractState = (contractId: string): ContractState => ({
  contractId,
  noticeDeadline: null,
  noticeStatus: null,
  windowCheckedAtMs: null,
  decisionItemKey: null,
  decisionItemTerm: null,
  decisionItemClaimedAtMs: null,
  renewedBy: null,
  renewedAtMs: null,
});

async function ensureState(contractId: string): Promise<void> {
  await change('INSERT IGNORE INTO contract_state (contract_id) VALUES (?)', contractId);
}

export async function getContractState(contractId: string): Promise<ContractState> {
  const rows = await select(`SELECT ${STATE_COLUMNS} FROM contract_state WHERE contract_id = ?`, contractId);
  return rows[0] ? toState(rows[0]) : emptyContractState(contractId);
}

export async function listContractStates(contractIds: readonly string[]): Promise<Map<string, ContractState>> {
  const rows = await inChunks(contractIds, async (chunk) =>
    (await select(`SELECT ${STATE_COLUMNS} FROM contract_state WHERE contract_id IN (${marks(chunk.length)})`, ...chunk)).map(toState),
  );
  return new Map(rows.map((s) => [s.contractId, s]));
}

export async function saveWindow(contractId: string, deadline: IsoDate | null, status: string, nowMs: number): Promise<void> {
  await ensureState(contractId);
  await change(
    'UPDATE contract_state SET notice_deadline = ?, notice_status = ?, window_checked_at_ms = ? WHERE contract_id = ?',
    deadline,
    status,
    nowMs,
    contractId,
  );
}

/**
 * Claims the right to open the "Decision due" item for a term, so the daily
 * trigger and a manual run cannot both open one. A claim that never got its
 * key (the call died) can be taken again once it is older than `staleBeforeMs`.
 */
export async function claimDecisionItem(contractId: string, termIndex: number, nowMs: number, staleBeforeMs: number): Promise<boolean> {
  await ensureState(contractId);
  const won = await change(
    'UPDATE contract_state SET decision_item_term = ?, decision_item_key = NULL, decision_item_claimed_at_ms = ? WHERE contract_id = ? ' +
      'AND (decision_item_term IS NULL OR decision_item_term < ? OR (decision_item_term = ? AND decision_item_key IS NULL AND decision_item_claimed_at_ms < ?))',
    termIndex,
    nowMs,
    contractId,
    termIndex,
    termIndex,
    staleBeforeMs,
  );
  return won === 1;
}

export async function setDecisionItemKey(contractId: string, termIndex: number, key: string): Promise<void> {
  await change('UPDATE contract_state SET decision_item_key = ? WHERE contract_id = ? AND decision_item_term = ?', key, contractId, termIndex);
}

export async function releaseDecisionItem(contractId: string, termIndex: number): Promise<void> {
  await change(
    'UPDATE contract_state SET decision_item_term = NULL, decision_item_claimed_at_ms = NULL ' +
      'WHERE contract_id = ? AND decision_item_term = ? AND decision_item_key IS NULL',
    contractId,
    termIndex,
  );
}

export async function recordRenewal(contractId: string, by: string | null, nowMs: number | null): Promise<void> {
  await ensureState(contractId);
  await change('UPDATE contract_state SET renewed_by = ?, renewed_at_ms = ? WHERE contract_id = ?', by, nowMs, contractId);
}

// ---- decision ----

export interface DecisionRow {
  id: string;
  contractId: string;
  runId: string | null;
  outcome: string;
  rationale: string | null;
  brief: unknown;
  termIndex: number;
  workItemKey: string | null;
  decidedBy: string;
  decidedAtMs: number;
}

const DECISION_COLUMNS = 'id, contract_id, run_id, outcome, rationale, brief_json, term_index, work_item_key, decided_by, decided_at_ms';

const toDecision = (r: Raw): DecisionRow => ({
  id: String(r.id),
  contractId: String(r.contract_id),
  runId: strOrNull(r.run_id),
  outcome: String(r.outcome),
  rationale: strOrNull(r.rationale),
  brief: json<unknown>(r.brief_json),
  termIndex: num(r.term_index),
  workItemKey: strOrNull(r.work_item_key),
  decidedBy: String(r.decided_by),
  decidedAtMs: num(r.decided_at_ms),
});

export async function insertDecision(d: DecisionRow): Promise<void> {
  await change(
    `INSERT INTO decision (${DECISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.id,
    d.contractId,
    d.runId,
    d.outcome,
    d.rationale,
    JSON.stringify(d.brief),
    d.termIndex,
    d.workItemKey,
    d.decidedBy,
    d.decidedAtMs,
  );
}

export async function listDecisionsForContract(contractId: string): Promise<DecisionRow[]> {
  return (await select(`SELECT ${DECISION_COLUMNS} FROM decision WHERE contract_id = ? ORDER BY decided_at_ms DESC LIMIT 20`, contractId)).map(
    toDecision,
  );
}

// ---- app_setting ----

export async function getSetting(name: string): Promise<string | null> {
  const rows = await select('SELECT value FROM app_setting WHERE name = ?', name);
  return rows[0] ? String(rows[0].value) : null;
}

export async function putSetting(name: string, value: string, by: string | null, nowMs: number): Promise<void> {
  await change('INSERT IGNORE INTO app_setting (name, value, updated_by, updated_at_ms) VALUES (?, ?, ?, ?)', name, value, by, nowMs);
  await change('UPDATE app_setting SET value = ?, updated_by = ?, updated_at_ms = ? WHERE name = ?', value, by, nowMs, name);
}

// ---- context_cache ----

export async function getCachedContext(contractId: string, accountId: string): Promise<{ fetchedAtMs: number; payload: unknown } | null> {
  const rows = await select('SELECT fetched_at_ms, payload FROM context_cache WHERE contract_id = ? AND account_id = ?', contractId, accountId);
  const row = rows[0];
  return row ? { fetchedAtMs: num(row.fetched_at_ms), payload: json<unknown>(row.payload) } : null;
}

export async function putCachedContext(contractId: string, accountId: string, payload: unknown, nowMs: number): Promise<void> {
  const text = JSON.stringify(payload);
  await change(
    'INSERT IGNORE INTO context_cache (contract_id, account_id, fetched_at_ms, payload) VALUES (?, ?, ?, ?)',
    contractId,
    accountId,
    nowMs,
    text,
  );
  await change('UPDATE context_cache SET fetched_at_ms = ?, payload = ? WHERE contract_id = ? AND account_id = ?', nowMs, text, contractId, accountId);
}

/** Context older than this is never served again, so the daily check deletes it: names are not kept. */
export async function purgeContextBefore(beforeMs: number): Promise<number> {
  return change('DELETE FROM context_cache WHERE fetched_at_ms < ?', beforeMs);
}

// ---- personal data (Atlassian's personal data reporting API) ----

/** A LIKE pattern that matches the text literally: account ids may contain `_`, which LIKE treats as a wildcard. */
const containing = (text: string): string => `%${text.replace(/[\%_]/g, (c) => `\${c}`)}%`;

const ACCOUNT_COLUMNS: ReadonlyArray<[table: string, column: string]> = [
  ['contract', 'created_by'],
  ['extraction_run', 'requested_by'],
  ['obligation', 'decided_by'],
  ['decision', 'decided_by'],
  ['contract_state', 'renewed_by'],
  ['app_setting', 'updated_by'],
  ['contract_setting', 'updated_by'],
  ['contract_detail', 'decided_by'],
  ['evidence_check', 'requested_by'],
  ['evidence_check', 'commented_by'],
  ['access_log', 'account_id'],
];

/** Every account id Covenant stores, including reviewers named inside a run's edited term facts. */
export async function listStoredAccountIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const [table, column] of ACCOUNT_COLUMNS) {
    for (const row of await select(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IS NOT NULL`)) ids.add(String(row.id));
  }
  for (const row of await select(`SELECT facts_json FROM extraction_run WHERE facts_json LIKE ?`, containing('"editedBy":"'))) {
    const editedBy = json<StoredFacts>(row.facts_json)?.editedBy;
    if (editedBy) ids.add(editedBy);
  }
  return [...ids];
}

export async function trackAccounts(ids: readonly string[], nowMs: number): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await change(
      `INSERT IGNORE INTO personal_data_report (account_id, stored_at_ms) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`,
      ...chunk.flatMap((id) => [id, nowMs]),
    );
  }
}

export async function listTrackedAccounts(): Promise<Array<{ accountId: string; storedAtMs: number; reportedAtMs: number | null }>> {
  return (await select('SELECT account_id, stored_at_ms, reported_at_ms FROM personal_data_report')).map((r) => ({
    accountId: String(r.account_id),
    storedAtMs: num(r.stored_at_ms),
    reportedAtMs: numOrNull(r.reported_at_ms),
  }));
}

export async function markAccountsReported(ids: readonly string[], nowMs: number): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await change(`UPDATE personal_data_report SET reported_at_ms = ? WHERE account_id IN (${marks(chunk.length)})`, nowMs, ...chunk);
  }
}

/** Atlassian says the account changed: Covenant keeps no copy of its profile, so only cached context naming it goes. */
export async function refreshAccount(accountId: string, nowMs: number): Promise<void> {
  await change('DELETE FROM context_cache WHERE payload LIKE ?', containing(accountId));
  await change('UPDATE personal_data_report SET stored_at_ms = ? WHERE account_id = ?', nowMs, accountId);
}

/** Atlassian says the account is closed: its id is replaced everywhere Covenant stored it, and cached context naming it goes. */
export async function eraseAccount(accountId: string, erased: string, nowMs: number): Promise<void> {
  for (const [table, column] of ACCOUNT_COLUMNS) {
    if (table === 'app_setting') await change(`UPDATE app_setting SET updated_by = NULL WHERE updated_by = ?`, accountId);
    // The access log's unique key includes the account, so a closed account's entries are removed rather than renamed.
    else if (table === 'access_log') await change('DELETE FROM access_log WHERE account_id = ?', accountId);
    else await change(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, erased, accountId);
  }
  for (const row of await select('SELECT id, facts_json FROM extraction_run WHERE facts_json LIKE ?', containing(accountId))) {
    const facts = json<StoredFacts>(row.facts_json);
    if (facts?.editedBy !== accountId) continue;
    await change('UPDATE extraction_run SET facts_json = ?, updated_at_ms = ? WHERE id = ?', JSON.stringify({ ...facts, editedBy: null }), nowMs, String(row.id));
  }
  await change('DELETE FROM context_cache WHERE account_id = ?', accountId);
  await change('DELETE FROM context_cache WHERE payload LIKE ?', containing(accountId));
  await change('DELETE FROM personal_data_report WHERE account_id = ?', accountId);
}

/** Decision snapshots written before Covenant stopped keeping people in them. */
export async function listDecisionSnapshotsWithPeople(limit: number): Promise<Array<{ id: string; brief: unknown }>> {
  const rows = await select(
    `SELECT id, brief_json FROM decision WHERE brief_json LIKE ? OR brief_json LIKE ? OR brief_json LIKE ? LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    containing('"owners":'),
    containing('"assignee":'),
    containing('"owner":'),
  );
  return rows.map((r) => ({ id: String(r.id), brief: json<unknown>(r.brief_json) }));
}

export async function replaceDecisionSnapshot(id: string, brief: unknown): Promise<void> {
  await change('UPDATE decision SET brief_json = ? WHERE id = ?', JSON.stringify(brief), id);
}

// ---- created_item: work items Covenant itself created ----

export type CreatedKind = 'obligation' | 'decision' | 'notice' | 'claim' | 'sample';

export async function recordCreatedItem(issueKey: string, contractId: string, kind: CreatedKind, nowMs: number): Promise<void> {
  await change('INSERT IGNORE INTO created_item (issue_key, contract_id, kind, created_at_ms) VALUES (?, ?, ?, ?)', issueKey, contractId, kind, nowMs);
}

/**
 * Keys of every work item Covenant created for a contract: recorded ones, plus
 * approved obligations and the decision item from before they were recorded.
 */
export async function listCreatedKeys(contractId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const row of await select('SELECT issue_key AS k FROM created_item WHERE contract_id = ?', contractId)) keys.add(String(row.k));
  for (const row of await select('SELECT work_item_key AS k FROM obligation WHERE contract_id = ? AND work_item_key IS NOT NULL', contractId)) keys.add(String(row.k));
  for (const row of await select('SELECT decision_item_key AS k FROM contract_state WHERE contract_id = ? AND decision_item_key IS NOT NULL', contractId)) keys.add(String(row.k));
  return keys;
}

export async function listCreatedItems(contractId: string, kind: CreatedKind): Promise<string[]> {
  return (await select('SELECT issue_key AS k FROM created_item WHERE contract_id = ? AND kind = ? ORDER BY created_at_ms DESC', contractId, kind)).map((r) => String(r.k));
}

// ---- contract_setting ----

export async function getContractSetting<T>(contractId: string, name: string): Promise<T | null> {
  const rows = await select('SELECT value FROM contract_setting WHERE contract_id = ? AND name = ?', contractId, name);
  try {
    return rows[0] ? (JSON.parse(String(rows[0].value)) as T) : null;
  } catch {
    return null;
  }
}

export async function listContractSettings<T>(name: string, contractIds: readonly string[]): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  if (contractIds.length === 0) return found;
  const rows = await inChunks(contractIds, async (chunk) => select(`SELECT contract_id, value FROM contract_setting WHERE name = ? AND contract_id IN (${marks(chunk.length)})`, name, ...chunk));
  for (const r of rows) {
    try {
      found.set(String(r.contract_id), JSON.parse(String(r.value)) as T);
    } catch {
      // An unreadable setting is treated as not set.
    }
  }
  return found;
}

export async function putContractSetting(contractId: string, name: string, value: unknown, by: string | null, nowMs: number): Promise<void> {
  const text = JSON.stringify(value);
  await change('INSERT IGNORE INTO contract_setting (contract_id, name, value, updated_by, updated_at_ms) VALUES (?, ?, ?, ?, ?)', contractId, name, text, by, nowMs);
  await change('UPDATE contract_setting SET value = ?, updated_by = ?, updated_at_ms = ? WHERE contract_id = ? AND name = ?', text, by, nowMs, contractId, name);
}

export async function listDecisionsForContracts(contractIds: readonly string[]): Promise<DecisionRow[]> {
  if (contractIds.length === 0) return [];
  return inChunks(contractIds, async (chunk) =>
    (await select(`SELECT ${DECISION_COLUMNS} FROM decision WHERE contract_id IN (${marks(chunk.length)}) ORDER BY decided_at_ms DESC`, ...chunk)).map(toDecision),
  );
}

// ---- details pass: parties, notices, value, service levels ----

export type DetailsRunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DetailsRunRow {
  runId: string;
  contractId: string;
  status: DetailsRunStatus;
  detailsVersion: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  quotesReturned: number;
  quotesVerified: number;
  rejectedCount: number;
  error: string | null;
  queuedAtMs: number;
  finishedAtMs: number | null;
}

const toDetailsRun = (r: Raw): DetailsRunRow => ({
  runId: String(r.run_id),
  contractId: String(r.contract_id),
  status: String(r.status) as DetailsRunStatus,
  detailsVersion: num(r.details_version),
  model: String(r.model),
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  calls: num(r.calls),
  quotesReturned: num(r.quotes_returned),
  quotesVerified: num(r.quotes_verified),
  rejectedCount: num(r.rejected_count),
  error: strOrNull(r.error),
  queuedAtMs: num(r.queued_at_ms),
  finishedAtMs: numOrNull(r.finished_at_ms),
});

export async function getDetailsRun(runId: string): Promise<DetailsRunRow | null> {
  const rows = await select('SELECT * FROM details_run WHERE run_id = ?', runId);
  return rows[0] ? toDetailsRun(rows[0]) : null;
}

export async function listDetailsRuns(runIds: readonly string[]): Promise<Map<string, DetailsRunRow>> {
  const out = new Map<string, DetailsRunRow>();
  if (runIds.length === 0) return out;
  const rows = await inChunks(runIds, async (chunk) => select(`SELECT * FROM details_run WHERE run_id IN (${marks(chunk.length)})`, ...chunk));
  for (const r of rows) out.set(String(r.run_id), toDetailsRun(r));
  return out;
}

/** Claims the details pass for a run: true when this call may run it (first time, a failed one, or one stuck since before `staleBeforeMs`). */
export async function claimDetailsRun(runId: string, contractId: string, detailsVersion: number, model: string, nowMs: number, staleBeforeMs: number): Promise<boolean> {
  const added = await change(
    "INSERT IGNORE INTO details_run (run_id, contract_id, status, details_version, model, queued_at_ms) VALUES (?, ?, 'running', ?, ?, ?)",
    runId,
    contractId,
    detailsVersion,
    model,
    nowMs,
  );
  if (added === 1) return true;
  const retaken = await change(
    "UPDATE details_run SET status = 'running', details_version = ?, model = ?, queued_at_ms = ?, error = NULL WHERE run_id = ? AND (status = 'failed' OR status = 'queued' OR (status = 'running' AND queued_at_ms < ?))",
    detailsVersion,
    model,
    nowMs,
    runId,
    staleBeforeMs,
  );
  return retaken === 1;
}

export async function markDetailsQueued(runId: string, contractId: string, detailsVersion: number, model: string, nowMs: number): Promise<boolean> {
  const added = await change(
    "INSERT IGNORE INTO details_run (run_id, contract_id, status, details_version, model, queued_at_ms) VALUES (?, ?, 'queued', ?, ?, ?)",
    runId,
    contractId,
    detailsVersion,
    model,
    nowMs,
  );
  if (added === 1) return true;
  return (await change("UPDATE details_run SET status = 'queued', queued_at_ms = ?, error = NULL WHERE run_id = ? AND status = 'failed'", nowMs, runId)) === 1;
}

export async function finishDetailsRun(
  runId: string,
  outcome: { status: 'done' | 'failed'; inputTokens: number; outputTokens: number; calls: number; quotesReturned: number; quotesVerified: number; rejectedCount: number; error: string | null },
  nowMs: number,
): Promise<void> {
  await change(
    'UPDATE details_run SET status = ?, input_tokens = ?, output_tokens = ?, calls = ?, quotes_returned = ?, quotes_verified = ?, rejected_count = ?, error = ?, finished_at_ms = ? WHERE run_id = ?',
    outcome.status,
    outcome.inputTokens,
    outcome.outputTokens,
    outcome.calls,
    outcome.quotesReturned,
    outcome.quotesVerified,
    outcome.rejectedCount,
    outcome.error,
    nowMs,
    runId,
  );
}

export type DetailDecision = 'pending' | 'confirmed' | 'rejected';

export interface DetailRow {
  id: string;
  runId: string;
  contractId: string;
  kind: DetailKind;
  ordinal: number;
  /** The kind's data as core produced it, without the nested quote locations' offsets. */
  data: unknown;
  quote: string;
  page: number;
  pageEnd: number;
  ambiguous: boolean;
  section: ClauseSection | null;
  confidence: string;
  status: 'ready' | 'needs_review';
  review: string[];
  decision: DetailDecision;
  decidedBy: string | null;
  decidedAtMs: number | null;
}

const toDetail = (r: Raw): DetailRow => ({
  id: String(r.id),
  runId: String(r.run_id),
  contractId: String(r.contract_id),
  kind: String(r.kind) as DetailKind,
  ordinal: num(r.ordinal),
  data: json<unknown>(r.data_json),
  quote: String(r.quote),
  page: num(r.page),
  pageEnd: num(r.page_end),
  ambiguous: bool(r.ambiguous),
  section: json<ClauseSection>(r.section_json),
  confidence: String(r.confidence),
  status: String(r.status) as DetailRow['status'],
  review: json<string[]>(r.review_json) ?? [],
  decision: String(r.decision) as DetailDecision,
  decidedBy: strOrNull(r.decided_by),
  decidedAtMs: numOrNull(r.decided_at_ms),
});

export async function deleteDetails(runId: string): Promise<void> {
  await change('DELETE FROM contract_detail WHERE run_id = ?', runId);
}

export async function insertDetail(d: Omit<DetailRow, 'decision' | 'decidedBy' | 'decidedAtMs'>, nowMs: number): Promise<void> {
  await change(
    'INSERT INTO contract_detail (id, run_id, contract_id, kind, ordinal, data_json, quote, page, page_end, ambiguous, section_json, confidence, status, review_json, decision, created_at_ms) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
    d.id,
    d.runId,
    d.contractId,
    d.kind,
    d.ordinal,
    JSON.stringify(d.data),
    d.quote,
    d.page,
    d.pageEnd,
    d.ambiguous ? 1 : 0,
    d.section === null ? null : JSON.stringify(d.section),
    d.confidence,
    d.status,
    JSON.stringify(d.review),
    nowMs,
  );
}

export async function listDetails(runId: string): Promise<DetailRow[]> {
  return (await select('SELECT * FROM contract_detail WHERE run_id = ? ORDER BY kind, ordinal', runId)).map(toDetail);
}

export async function listDetailsForRuns(runIds: readonly string[], kind?: DetailKind): Promise<DetailRow[]> {
  if (runIds.length === 0) return [];
  return inChunks(runIds, async (chunk) =>
    (
      await select(
        `SELECT * FROM contract_detail WHERE run_id IN (${marks(chunk.length)})${kind ? ' AND kind = ?' : ''} ORDER BY kind, ordinal`,
        ...chunk,
        ...(kind ? [kind] : []),
      )
    ).map(toDetail),
  );
}

export async function getDetail(id: string): Promise<DetailRow | null> {
  const rows = await select('SELECT * FROM contract_detail WHERE id = ?', id);
  return rows[0] ? toDetail(rows[0]) : null;
}

export async function decideDetail(id: string, decision: DetailDecision, by: string, nowMs: number): Promise<boolean> {
  return (await change('UPDATE contract_detail SET decision = ?, decided_by = ?, decided_at_ms = ? WHERE id = ?', decision, by, nowMs, id)) === 1;
}

// --- Evidence checks ---------------------------------------------------------

/** The approved obligation whose work item this is, if Covenant created it. */
export async function findObligationByWorkItem(issueId: string): Promise<ObligationRow | null> {
  const rows = await select(`SELECT ${OBLIGATION_COLUMNS} FROM obligation WHERE work_item_id = ? AND decision = 'approved' ORDER BY updated_at_ms DESC LIMIT 1`, issueId);
  return rows[0] ? toObligation(rows[0]) : null;
}

export type EvidenceStatus = 'queued' | 'running' | 'done' | 'failed';
export type EvidenceVerdictValue = 'pass' | 'fail' | 'needs_review';

export interface EvidenceCheckRow {
  id: string;
  obligationId: string;
  contractId: string;
  issueId: string;
  attachmentId: string;
  fileName: string;
  /** 'panel' when a person clicked Check, 'attachment' when Covenant saw the file arrive. */
  source: string;
  status: EvidenceStatus;
  verdict: EvidenceVerdictValue | null;
  result: unknown;
  evidenceVersion: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  error: string | null;
  requestedBy: string | null;
  commentedBy: string | null;
  queuedAtMs: number;
  finishedAtMs: number | null;
}

const toEvidence = (r: Raw): EvidenceCheckRow => ({
  id: String(r.id),
  obligationId: String(r.obligation_id),
  contractId: String(r.contract_id),
  issueId: String(r.issue_id),
  attachmentId: String(r.attachment_id),
  fileName: String(r.file_name),
  source: String(r.source),
  status: String(r.status) as EvidenceStatus,
  verdict: strOrNull(r.verdict) as EvidenceVerdictValue | null,
  result: json<unknown>(r.result_json),
  evidenceVersion: num(r.evidence_version),
  model: String(r.model),
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  calls: num(r.calls),
  error: strOrNull(r.error),
  requestedBy: strOrNull(r.requested_by),
  commentedBy: strOrNull(r.commented_by),
  queuedAtMs: num(r.queued_at_ms),
  finishedAtMs: numOrNull(r.finished_at_ms),
});

/** Queues a check, or re-queues one that failed. False when it is already queued, running or done. */
export async function queueEvidenceCheck(
  c: Pick<EvidenceCheckRow, 'id' | 'obligationId' | 'contractId' | 'issueId' | 'attachmentId' | 'fileName' | 'source' | 'evidenceVersion' | 'model' | 'requestedBy'>,
  nowMs: number,
): Promise<{ id: string; queued: boolean }> {
  const inserted = await change(
    'INSERT IGNORE INTO evidence_check (id, obligation_id, contract_id, issue_id, attachment_id, file_name, source, status, evidence_version, model, requested_by, queued_at_ms) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
    c.id,
    c.obligationId,
    c.contractId,
    c.issueId,
    c.attachmentId,
    c.fileName.slice(0, 255),
    c.source,
    c.evidenceVersion,
    c.model,
    c.requestedBy,
    nowMs,
  );
  if (inserted === 1) return { id: c.id, queued: true };
  const rows = await select('SELECT id FROM evidence_check WHERE obligation_id = ? AND attachment_id = ? AND evidence_version = ?', c.obligationId, c.attachmentId, c.evidenceVersion);
  const id = rows[0] ? String(rows[0].id) : c.id;
  const requeued = await change(
    "UPDATE evidence_check SET status = 'queued', verdict = NULL, result_json = NULL, error = NULL, source = ?, requested_by = ?, queued_at_ms = ?, finished_at_ms = NULL WHERE id = ? AND status = 'failed'",
    c.source,
    c.requestedBy,
    nowMs,
    id,
  );
  return { id, queued: requeued === 1 };
}

/** Takes a queued check, or one left running by a worker that died. */
export async function claimEvidenceCheck(id: string, nowMs: number, staleBeforeMs: number): Promise<boolean> {
  return (
    (await change(
      "UPDATE evidence_check SET status = 'running', queued_at_ms = ? WHERE id = ? AND (status = 'queued' OR (status = 'running' AND queued_at_ms < ?))",
      nowMs,
      id,
      staleBeforeMs,
    )) === 1
  );
}

export async function finishEvidenceCheck(
  id: string,
  f: { status: 'done' | 'failed'; verdict: EvidenceVerdictValue | null; result: unknown; model: string; inputTokens: number; outputTokens: number; calls: number; error: string | null },
  nowMs: number,
): Promise<void> {
  await change(
    'UPDATE evidence_check SET status = ?, verdict = ?, result_json = ?, model = ?, input_tokens = ?, output_tokens = ?, calls = ?, error = ?, finished_at_ms = ? WHERE id = ?',
    f.status,
    f.verdict,
    f.result === null ? null : JSON.stringify(f.result),
    f.model,
    f.inputTokens,
    f.outputTokens,
    f.calls,
    f.error === null ? null : f.error.slice(0, 500),
    nowMs,
    id,
  );
}

export async function getEvidenceCheck(id: string): Promise<EvidenceCheckRow | null> {
  const rows = await select('SELECT * FROM evidence_check WHERE id = ?', id);
  return rows[0] ? toEvidence(rows[0]) : null;
}

export async function listEvidenceChecks(obligationId: string): Promise<EvidenceCheckRow[]> {
  return (await select('SELECT * FROM evidence_check WHERE obligation_id = ? ORDER BY queued_at_ms DESC', obligationId)).map(toEvidence);
}

/** Records who posted the chase draft as a comment. False when someone already did. */
export async function markEvidenceCommented(id: string, accountId: string): Promise<boolean> {
  return (await change('UPDATE evidence_check SET commented_by = ? WHERE id = ? AND commented_by IS NULL', accountId, id)) === 1;
}

export async function unmarkEvidenceCommented(id: string): Promise<void> {
  await change('UPDATE evidence_check SET commented_by = NULL WHERE id = ?', id);
}

// --- AI access log -------------------------------------------------------------

export type AccessChannel = 'panel' | 'rovo' | 'mcp';

export interface AccessEntry {
  accountId: string;
  channel: AccessChannel;
  action: string;
  /** The obligation whose clause was read, or '' for contract-level reads such as a renewal brief. */
  obligationId: string;
  contractId: string;
}

const ACCESS_BUCKET_MS = 10 * 60 * 1000;

/** One statement for many reads. Repeats in the same ten minutes are ignored by the unique key. */
export async function logAccess(entries: readonly AccessEntry[], nowMs: number): Promise<number> {
  if (entries.length === 0) return 0;
  const bucket = Math.floor(nowMs / ACCESS_BUCKET_MS);
  let written = 0;
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    written += await change(
      `INSERT IGNORE INTO access_log (account_id, channel, action, obligation_id, contract_id, bucket, at_ms) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      ...chunk.flatMap((e) => [e.accountId, e.channel, e.action.slice(0, 32), e.obligationId, e.contractId, bucket, nowMs]),
    );
  }
  return written;
}

export interface AccessRow extends AccessEntry {
  atMs: number;
  /** The obligation's kind and the contract's work item key, for the admin's list. Null when they have since been deleted. */
  kind: string | null;
  issueKey: string | null;
}

export async function listAccess(limit: number): Promise<AccessRow[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return (
    await select(
      'SELECT a.account_id, a.channel, a.action, a.obligation_id, a.contract_id, a.at_ms, o.kind, c.issue_key FROM access_log a ' +
        `LEFT JOIN obligation o ON o.id = a.obligation_id LEFT JOIN contract c ON c.id = a.contract_id ORDER BY a.at_ms DESC LIMIT ${n}`,
    )
  ).map((r) => ({
    accountId: String(r.account_id),
    channel: String(r.channel) as AccessChannel,
    action: String(r.action),
    obligationId: String(r.obligation_id),
    contractId: String(r.contract_id),
    atMs: num(r.at_ms),
    kind: strOrNull(r.kind),
    issueKey: strOrNull(r.issue_key),
  }));
}

export async function countAccessByChannel(sinceMs: number): Promise<Record<AccessChannel, number>> {
  const out: Record<AccessChannel, number> = { panel: 0, rovo: 0, mcp: 0 };
  for (const r of await select('SELECT channel, COUNT(*) AS n FROM access_log WHERE at_ms >= ? GROUP BY channel', sinceMs)) {
    const channel = String(r.channel) as AccessChannel;
    if (channel in out) out[channel] = num(r.n);
  }
  return out;
}

/** Entries older than the retention period go, run by the daily check. */
export async function purgeAccessBefore(beforeMs: number): Promise<number> {
  return change('DELETE FROM access_log WHERE at_ms < ?', beforeMs);
}

// --- Quality -------------------------------------------------------------------

/** Approved obligations, and how many of those a person approved without changing the extractor's rule. */
export async function approvalQuality(): Promise<{ approved: number; unedited: number; rejected: number; pending: number }> {
  const rows = await select(
    "SELECT decision, CASE WHEN rule_json = original_rule_json THEN 1 ELSE 0 END AS same, COUNT(*) AS n FROM obligation GROUP BY decision, CASE WHEN rule_json = original_rule_json THEN 1 ELSE 0 END",
  );
  const out = { approved: 0, unedited: 0, rejected: 0, pending: 0 };
  for (const r of rows) {
    const decision = String(r.decision);
    const n = num(r.n);
    if (decision === 'approved') {
      out.approved += n;
      if (num(r.same) === 1) out.unedited += n;
    } else if (decision === 'rejected') out.rejected += n;
    else out.pending += n;
  }
  return out;
}
