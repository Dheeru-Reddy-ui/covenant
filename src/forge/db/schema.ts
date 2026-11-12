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

const migrations = migrationRunner
  .enqueue('v001_create_spike_probe', V001_SPIKE_PROBE)
  .enqueue('v002_create_contract', V002_CONTRACT)
  .enqueue('v003_create_extraction_run', V003_EXTRACTION_RUN)
  .enqueue('v004_create_clause', V004_CLAUSE)
  .enqueue('v005_create_obligation', V005_OBLIGATION)
  .enqueue('v006_create_decision', V006_DECISION)
  .enqueue('v007_create_contract_state', V007_CONTRACT_STATE)
  .enqueue('v008_create_app_setting', V008_APP_SETTING)
  .enqueue('v009_create_context_cache', V009_CONTEXT_CACHE);

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
