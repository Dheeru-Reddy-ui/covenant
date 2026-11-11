import { migrationRunner, sql } from '@forge/sql';

/**
 * S5: create one Forge SQL table by migration, then insert and select a row.
 *
 * Pass: `roundTrip` is true. Fallback if it fails: the key-value store, one
 * record per contract.
 *
 * Forge SQL is MySQL-compatible with limits that shape the real schema:
 * no foreign keys, one statement per query, positional `?` parameters only.
 */

const CREATE_SPIKE_PROBE = `
CREATE TABLE IF NOT EXISTS spike_probe (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  label VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

// Enqueued once per runtime. The docs ask for a single migrationRunner chain per app.
const migrations = migrationRunner.enqueue('v001_create_spike_probe', CREATE_SPIKE_PROBE);

export interface SqlSpikeResult {
  migrationsAppliedNow: string[];
  migrationsOnRecord: string[];
  insertedId: number | null;
  rowsBack: number;
  roundTrip: boolean;
  totalRows: number | null;
  ms: number;
}

export async function runSqlSpike(): Promise<SqlSpikeResult> {
  const started = Date.now();
  const migrationsAppliedNow = await migrations.run();
  const migrationsOnRecord = (await migrationRunner.list()).map((m) => m.name);

  const label = `probe-${started}`;
  const insert = await sql.prepare('INSERT INTO spike_probe (label) VALUES (?)').bindParams(label).execute();
  const insertedId = (insert.rows as { insertId?: number } | undefined)?.insertId ?? null;

  const select = await sql
    .prepare<{ id: number; label: string }>('SELECT id, label FROM spike_probe WHERE label = ?')
    .bindParams(label)
    .execute();
  const rows = Array.isArray(select.rows) ? select.rows : [];

  const count = await sql.prepare<{ total: number }>('SELECT COUNT(*) AS total FROM spike_probe').execute();
  const countRows = Array.isArray(count.rows) ? count.rows : [];

  return {
    migrationsAppliedNow,
    migrationsOnRecord,
    insertedId,
    rowsBack: rows.length,
    roundTrip: rows.length === 1 && rows[0]?.label === label,
    totalRows: countRows[0] ? Number(countRows[0].total) : null,
    ms: Date.now() - started,
  };
}
