import Resolver from '@forge/resolver';
import { CORE_VERSION, SCHEMA_VERSION, resolveRule } from '../../../packages/core/src';
import { runAttachmentSpike } from './s1-attachment';
import { runLlmSpike } from './s2-llm';
import { runExtractorSpike } from './s2b-extractor';
import { runGraphSpike } from './s3-graph';
import { runSqlSpike } from './s5-sql';

/**
 * Resolvers behind the "Covenant spikes" issue panel. Each returns
 * `{ ok, ms, result | error }` so the panel can show a pass or a failure
 * without the function ever throwing into the void.
 *
 * Logs carry spike names, statuses and timings only. Never contract text.
 */

export interface SpikeOutcome<T> {
  ok: boolean;
  ms: number;
  result?: T;
  error?: { name: string; message: string; status?: number; details?: string[] };
}

async function attempt<T>(spike: string, run: () => Promise<T>): Promise<SpikeOutcome<T>> {
  const started = Date.now();
  try {
    const result = await run();
    const ms = Date.now() - started;
    // Spike results hold counts, hashes, flags and work item keys only, never contract text.
    console.log(`spike ${spike} finished ok ms=${ms} result=${JSON.stringify(result).slice(0, 3000)}`);
    return { ok: true, ms, result };
  } catch (caught) {
    const ms = Date.now() - started;
    const error = caught instanceof Error ? caught : new Error('non-error thrown');
    const extra = caught as { status?: unknown; statusCode?: unknown; graphErrors?: unknown; code?: unknown };
    const status = typeof extra.status === 'number' ? extra.status : typeof extra.statusCode === 'number' ? extra.statusCode : undefined;
    const details = Array.isArray(extra.graphErrors) ? extra.graphErrors.map(String) : undefined;
    console.error(
      `spike ${spike} failed name=${error.name} status=${status ?? 'n/a'} ms=${ms} message=${error.message.slice(0, 500)} details=${JSON.stringify(details ?? []).slice(0, 1500)}`,
    );
    return {
      ok: false,
      ms,
      error: {
        name: error.name,
        message: error.message,
        ...(status !== undefined ? { status } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    };
  }
}

interface PanelContext {
  accountId?: string;
  extension?: { issue?: { key?: string } };
}

const resolver = new Resolver();

// S0: packages/core, imported by relative path, bundles and runs inside Forge unchanged.
resolver.define('spike.s0', () =>
  attempt('s0', async () => {
    const resolution = resolveRule(
      { anchor: 'term_end', offset: { count: 90, unit: 'day', direction: 'before' }, recurrence: null },
      {
        terms: {
          effectiveDate: '2025-03-01',
          initialTerm: { count: 2, unit: 'year' },
          initialTermEnd: null,
          renewalTerm: { count: 1, unit: 'year' },
        },
        termIndex: 0,
      },
    );
    const date = resolution.status === 'resolved' ? resolution.occurrences[0]?.date : undefined;
    return { coreVersion: CORE_VERSION, schemaVersion: SCHEMA_VERSION, date, expected: '2026-11-30', matches: date === '2026-11-30' };
  }),
);

resolver.define('spike.s1', ({ context }) =>
  attempt('s1', async () => {
    const issueKey = (context as PanelContext).extension?.issue?.key;
    if (!issueKey) throw new Error('no work item key in the panel context');
    return runAttachmentSpike(issueKey);
  }),
);

resolver.define('spike.s2', () => attempt('s2', () => runLlmSpike()));

// S2b: the Phase 1 extractor and the production LLM adapter, including one forced repair turn.
resolver.define('spike.s2b', () => attempt('s2b', () => runExtractorSpike()));

resolver.define('spike.s3', ({ context }) =>
  attempt('s3', async () => {
    const accountId = (context as PanelContext).accountId;
    if (!accountId) throw new Error('no signed-in user in the panel context');
    return runGraphSpike(accountId);
  }),
);

resolver.define('spike.s5', () => attempt('s5', () => runSqlSpike()));

export const handler = resolver.getDefinitions();
