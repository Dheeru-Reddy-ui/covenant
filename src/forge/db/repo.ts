import { type UpdateQueryResponse, sql } from '@forge/sql';
import type {
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
  const rows = await select(`SELECT ${CONTRACT_COLUMNS} FROM contract WHERE issue_id = ? AND attachment_sha256 = ?`, issueId, sha256);
  return rows[0] ? toContract(rows[0]) : null;
}

export async function getContract(id: string): Promise<ContractRow | null> {
  const rows = await select(`SELECT ${CONTRACT_COLUMNS} FROM contract WHERE id = ?`, id);
  return rows[0] ? toContract(rows[0]) : null;
}

export async function setContractAttachment(id: string, attachmentId: string): Promise<void> {
  await change('UPDATE contract SET attachment_id = ? WHERE id = ?', attachmentId, id);
}

export async function listContractsForIssue(issueId: string): Promise<ContractRow[]> {
  const rows = await select(`SELECT ${CONTRACT_COLUMNS} FROM contract WHERE issue_id = ? ORDER BY created_at_ms DESC LIMIT 20`, issueId);
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
});

export async function insertClause(c: ClauseRow): Promise<void> {
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
}

export async function getClause(id: string): Promise<ClauseRow | null> {
  const rows = await select(`SELECT ${CLAUSE_COLUMNS} FROM clause WHERE id = ?`, id);
  return rows[0] ? toClause(rows[0]) : null;
}

export async function listClauses(runId: string): Promise<ClauseRow[]> {
  return (await select(`SELECT ${CLAUSE_COLUMNS} FROM clause WHERE run_id = ?`, runId)).map(toClause);
}

/** Clears what an earlier, interrupted attempt at this run left behind. */
export async function deleteRunContent(runId: string): Promise<void> {
  await change('DELETE FROM obligation WHERE run_id = ?', runId);
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
