import * as repo from './db/repo';
import { loggableError } from './errors';

/**
 * The AI access log: which person read which obligation's clause, when, and
 * through which channel. It stores ids only, never clause text. A failure to
 * log never fails the read itself: it is reported in the app log by count.
 */

export type { AccessChannel } from './db/repo';

const pick = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

/**
 * Which channel a tool call came through. Spike S4: an MCP call carries the
 * caller at context.principal.accountId, while Rovo chat puts it at
 * context.accountId. Checked live after deploy (docs/spikes.md).
 */
export const toolChannel = (context: unknown): repo.AccessChannel => (typeof pick(context, ['principal', 'accountId']) === 'string' ? 'mcp' : 'rovo');

export async function logReads(
  accountId: string,
  channel: repo.AccessChannel,
  action: string,
  reads: ReadonlyArray<{ obligationId: string | null; contractId: string }>,
): Promise<void> {
  if (reads.length === 0) return;
  const seen = new Set<string>();
  const entries: repo.AccessEntry[] = [];
  for (const r of reads) {
    const key = `${r.obligationId ?? ''}|${r.contractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      accountId,
      channel,
      action,
      obligationId: r.obligationId ?? '',
      contractId: r.contractId,
    });
  }
  try {
    await repo.logAccess(entries, Date.now());
  } catch (error) {
    console.error(`access log failed channel=${channel} action=${action} reads=${entries.length} error=${loggableError(error)}`);
  }
}
