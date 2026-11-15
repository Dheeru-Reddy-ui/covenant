import { migrationRunner } from '@forge/sql';

/**
 * Forge SQL schema. Migrations do not run on deploy, so every entry point calls
 * ensureSchema() first; after the first call in a runtime it costs nothing.
 *
 * Forge SQL has no foreign keys and no transactions, so ids are app-made UUIDs,
 * idempotency comes from unique keys plus INSERT IGNORE, and every state change
 * is a conditional UPDATE whose affectedRows says whether it won.
 * Times are epoch milliseconds; dates the engine works out are DATE columns.
 */

// Applied by spike S5. Kept first, unchanged, so the recorded history still matches this chain.
const V001_SPIKE_PROBE = `
CREATE TABLE IF NOT EXISTS spike_probe (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  label VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/** One contract file on one work item. The same bytes attached twice are the same contract. */
const V002_CONTRACT = `
CREATE TABLE IF NOT EXISTS contract (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  issue_id VARCHAR(32) NOT NULL,
  issue_key VARCHAR(64) NOT NULL,
  project_id VARCHAR(32) NOT NULL,
  attachment_id VARCHAR(32) NOT NULL,
  attachment_sha256 CHAR(64) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_kind VARCHAR(8) NOT NULL,
  byte_length INT NOT NULL,
  term_index INT NOT NULL DEFAULT 0,
  created_by VARCHAR(128) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_contract_issue_file (issue_id, attachment_sha256),
  KEY ix_contract_issue (issue_id)
)`;

/** One extraction of a contract. Unique per contract and extractor version, so a second Extract finds the first run. */
const V003_EXTRACTION_RUN = `
CREATE TABLE IF NOT EXISTS extraction_run (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  contract_id VARCHAR(36) NOT NULL,
  extractor_version INT NOT NULL,
  schema_version INT NOT NULL,
  model VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  job_id VARCHAR(128) NULL,
  attempts INT NOT NULL DEFAULT 0,
  error_code VARCHAR(48) NULL,
  error_message VARCHAR(1000) NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  llm_calls INT NOT NULL DEFAULT 0,
  second_passes INT NOT NULL DEFAULT 0,
  repaired TINYINT NOT NULL DEFAULT 0,
  quotes_returned INT NOT NULL DEFAULT 0,
  quotes_verified INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  pages INT NULL,
  chars INT NULL,
  paginated TINYINT NULL,
  facts_json MEDIUMTEXT NULL,
  terms_json TEXT NULL,
  auto_renew TINYINT NOT NULL DEFAULT 0,
  requested_by VARCHAR(128) NOT NULL,
  queued_at_ms BIGINT NOT NULL,
  started_at_ms BIGINT NULL,
  finished_at_ms BIGINT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_run_contract_version (contract_id, extractor_version)
)`;

/** A span of contract text that code found verbatim. Contract text lives here, never in logs. */
const V004_CLAUSE = `
CREATE TABLE IF NOT EXISTS clause (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  contract_id VARCHAR(36) NOT NULL,
  role VARCHAR(24) NOT NULL,
  quote TEXT NOT NULL,
  page INT NOT NULL,
  page_end INT NOT NULL,
  start_offset INT NOT NULL,
  end_offset INT NOT NULL,
  occurrences INT NOT NULL,
  ambiguous TINYINT NOT NULL,
  KEY ix_clause_run (run_id)
)`;

const V005_OBLIGATION = `
CREATE TABLE IF NOT EXISTS obligation (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  contract_id VARCHAR(36) NOT NULL,
  clause_id VARCHAR(36) NOT NULL,
  ordinal INT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  responsible_party VARCHAR(120) NOT NULL,
  summary VARCHAR(300) NOT NULL,
  rule_json TEXT NOT NULL,
  original_rule_json TEXT NOT NULL,
  second_rule_json TEXT NULL,
  confidence VARCHAR(8) NOT NULL,
  extractor_status VARCHAR(16) NOT NULL,
  review_json TEXT NOT NULL,
  decision VARCHAR(16) NOT NULL,
  event_date DATE NULL,
  due_date DATE NULL,
  schedule_status VARCHAR(16) NOT NULL,
  work_item_id VARCHAR(32) NULL,
  work_item_key VARCHAR(64) NULL,
  last_error VARCHAR(1000) NULL,
  decided_by VARCHAR(128) NULL,
  decided_at_ms BIGINT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_obligation_run_ordinal (run_id, ordinal),
  KEY ix_obligation_contract (contract_id),
  KEY ix_obligation_due (due_date)
)`;

/** Renew, renegotiate or terminate, with the rationale and the brief it was made on. Written from Phase 3. */
const V006_DECISION = `
CREATE TABLE IF NOT EXISTS decision (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  contract_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NULL,
  outcome VARCHAR(16) NOT NULL,
  rationale TEXT NULL,
  brief_json MEDIUMTEXT NULL,
  term_index INT NOT NULL,
  work_item_key VARCHAR(64) NULL,
  decided_by VARCHAR(128) NOT NULL,
  decided_at_ms BIGINT NOT NULL,
  KEY ix_decision_contract (contract_id)
)`;

/** What the daily check last worked out for a contract, and the "Decision due" item it opened. A new table, not ALTERs. */
const V007_CONTRACT_STATE = `
CREATE TABLE IF NOT EXISTS contract_state (
  contract_id VARCHAR(36) NOT NULL PRIMARY KEY,
  notice_deadline DATE NULL,
  notice_status VARCHAR(16) NULL,
  window_checked_at_ms BIGINT NULL,
  decision_item_key VARCHAR(64) NULL,
  decision_item_term INT NULL,
  decision_item_claimed_at_ms BIGINT NULL,
  renewed_by VARCHAR(128) NULL,
  renewed_at_ms BIGINT NULL
)`;

const V008_APP_SETTING = `
CREATE TABLE IF NOT EXISTS app_setting (
  name VARCHAR(64) NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by VARCHAR(128) NULL,
  updated_at_ms BIGINT NOT NULL
)`;

/** Graph and Jira context for a decision brief, per contract and per user: results are filtered by each user's permissions. */
const V009_CONTEXT_CACHE = `
CREATE TABLE IF NOT EXISTS context_cache (
  contract_id VARCHAR(36) NOT NULL,
  account_id VARCHAR(128) NOT NULL,
  fetched_at_ms BIGINT NOT NULL,
  payload MEDIUMTEXT NOT NULL,
  PRIMARY KEY (contract_id, account_id)
)`;

/**
 * The numbered clause each verified quote sits in, found by code from the text around it.
 * A row with a null clause_number means code looked and found none. No row means it has not looked yet.
 */
const V010_CLAUSE_SECTION = `
CREATE TABLE IF NOT EXISTS clause_section (
  clause_id VARCHAR(36) NOT NULL PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  label VARCHAR(16) NULL,
  clause_number VARCHAR(32) NULL,
  heading VARCHAR(120) NULL,
  found_at_ms BIGINT NOT NULL,
  KEY idx_clause_section_run (run_id)
)`;

/**
 * Accounts whose ids Covenant stores, for Atlassian's personal data reporting API:
 * when it first stored each one (the updatedAt it reports) and when it last reported it.
 */
const V011_PERSONAL_DATA_REPORT = `
CREATE TABLE IF NOT EXISTS personal_data_report (
  account_id VARCHAR(128) NOT NULL PRIMARY KEY,
  stored_at_ms BIGINT NOT NULL,
  reported_at_ms BIGINT NULL
)`;

/** Every work item Covenant itself created, so its own items never count as related work or as evidence of ownership. */
const V012_CREATED_ITEM = `
CREATE TABLE IF NOT EXISTS created_item (
  issue_key VARCHAR(64) NOT NULL PRIMARY KEY,
  contract_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  KEY idx_created_item_contract (contract_id)
)`;

/** Per-contract settings a person chooses: the holiday calendar, the supplier filter. One row per setting. */
const V013_CONTRACT_SETTING = `
CREATE TABLE IF NOT EXISTS contract_setting (
  contract_id VARCHAR(36) NOT NULL,
  name VARCHAR(64) NOT NULL,
  value MEDIUMTEXT NOT NULL,
  updated_by VARCHAR(128) NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (contract_id, name)
)`;

/** One row per run of the details pass (parties, notices, value, service levels), keyed on the extraction run it reads for. */
const V014_DETAILS_RUN = `
CREATE TABLE IF NOT EXISTS details_run (
  run_id VARCHAR(36) NOT NULL PRIMARY KEY,
  contract_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  details_version INT NOT NULL,
  model VARCHAR(64) NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  calls INT NOT NULL DEFAULT 0,
  quotes_returned INT NOT NULL DEFAULT 0,
  quotes_verified INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  error VARCHAR(500) NULL,
  queued_at_ms BIGINT NOT NULL,
  finished_at_ms BIGINT NULL,
  KEY idx_details_run_contract (contract_id)
)`;

/** What the details pass found. Every row carries its verbatim quote and where code found it. */
const V015_CONTRACT_DETAIL = `
CREATE TABLE IF NOT EXISTS contract_detail (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  contract_id VARCHAR(36) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  ordinal INT NOT NULL,
  data_json MEDIUMTEXT NOT NULL,
  quote TEXT NOT NULL,
  page INT NOT NULL,
  page_end INT NOT NULL,
  ambiguous TINYINT NOT NULL DEFAULT 0,
  section_json VARCHAR(400) NULL,
  confidence VARCHAR(8) NOT NULL,
  status VARCHAR(16) NOT NULL,
  review_json TEXT NOT NULL,
  decision VARCHAR(16) NOT NULL,
  decided_by VARCHAR(128) NULL,
  decided_at_ms BIGINT NULL,
  created_at_ms BIGINT NOT NULL,
  KEY idx_contract_detail_run (run_id),
  KEY idx_contract_detail_contract (contract_id)
)`;

/**
 * Evidence checks: a certificate or report attached to an obligation's work
 * item, read against the obligation's clause. One row per obligation, file and
 * checker version. result_json holds the findings with their quotes from both
 * documents; it is shown to people and never logged.
 */
const V016_EVIDENCE_CHECK = `
CREATE TABLE IF NOT EXISTS evidence_check (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  obligation_id VARCHAR(36) NOT NULL,
  contract_id VARCHAR(36) NOT NULL,
  issue_id VARCHAR(32) NOT NULL,
  attachment_id VARCHAR(32) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  source VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  verdict VARCHAR(16) NULL,
  result_json MEDIUMTEXT NULL,
  evidence_version INT NOT NULL,
  model VARCHAR(64) NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  calls INT NOT NULL DEFAULT 0,
  error VARCHAR(500) NULL,
  requested_by VARCHAR(128) NULL,
  commented_by VARCHAR(128) NULL,
  queued_at_ms BIGINT NOT NULL,
  finished_at_ms BIGINT NULL,
  UNIQUE KEY uq_evidence_check (obligation_id, attachment_id, evidence_version),
  KEY idx_evidence_check_issue (issue_id)
)`;

/**
 * The AI access log: who read which obligation's clause, when, and through
 * which channel (the panel, the Rovo agent or MCP). Never clause text. One row
 * per person, channel and obligation in each ten-minute bucket, so polling and
 * repeated calls do not flood it.
 */
const V017_ACCESS_LOG = `
CREATE TABLE IF NOT EXISTS access_log (
  account_id VARCHAR(128) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  action VARCHAR(32) NOT NULL,
  obligation_id VARCHAR(36) NOT NULL,
  contract_id VARCHAR(36) NOT NULL,
  bucket BIGINT NOT NULL,
  at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_access_log (account_id, channel, obligation_id, contract_id, bucket),
  KEY idx_access_log_at (at_ms)
)`;

const migrations = migrationRunner
  .enqueue('v001_create_spike_probe', V001_SPIKE_PROBE)
  .enqueue('v002_create_contract', V002_CONTRACT)
  .enqueue('v003_create_extraction_run', V003_EXTRACTION_RUN)
  .enqueue('v004_create_clause', V004_CLAUSE)
  .enqueue('v005_create_obligation', V005_OBLIGATION)
  .enqueue('v006_create_decision', V006_DECISION)
  .enqueue('v007_create_contract_state', V007_CONTRACT_STATE)
  .enqueue('v008_create_app_setting', V008_APP_SETTING)
  .enqueue('v009_create_context_cache', V009_CONTEXT_CACHE)
  .enqueue('v010_create_clause_section', V010_CLAUSE_SECTION)
  .enqueue('v011_create_personal_data_report', V011_PERSONAL_DATA_REPORT)
  .enqueue('v012_create_created_item', V012_CREATED_ITEM)
  .enqueue('v013_create_contract_setting', V013_CONTRACT_SETTING)
  .enqueue('v014_create_details_run', V014_DETAILS_RUN)
  .enqueue('v015_create_contract_detail', V015_CONTRACT_DETAIL)
  .enqueue('v016_create_evidence_check', V016_EVIDENCE_CHECK)
  .enqueue('v017_create_access_log', V017_ACCESS_LOG);

let ready: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  ready ??= migrations.run().then(
    (applied) => {
      if (applied.length > 0) console.log(`sql migrations applied: ${applied.join(',')}`);
    },
    (error: unknown) => {
      ready = null;
      throw error;
    },
  );
  return ready;
}
