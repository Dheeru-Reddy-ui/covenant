import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The weekly personal data report: which accounts go out, and what happens to
 * closed and changed ones. The database is faked; the reporting call is passed in.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const db = vi.hoisted(() => ({
  stored: [] as string[],
  tracked: [] as Array<{ accountId: string; storedAtMs: number; reportedAtMs: number | null }>,
  snapshots: [] as Array<{ id: string; brief: unknown }>,
  replaced: new Map<string, unknown>(),
  reported: [] as string[],
  erased: [] as string[],
  refreshed: [] as string[],
  purgedBefore: [] as number[],
}));

vi.mock('../../src/forge/db/repo', () => ({
  listDecisionSnapshotsWithPeople: async () => db.snapshots,
  replaceDecisionSnapshot: async (id: string, brief: unknown) => void db.replaced.set(id, brief),
  purgeContextBefore: async (before: number) => {
    db.purgedBefore.push(before);
    return 2;
  },
  listStoredAccountIds: async () => db.stored,
  trackAccounts: async (ids: string[], nowMs: number) => {
    for (const id of ids) if (!db.tracked.some((t) => t.accountId === id)) db.tracked.push({ accountId: id, storedAtMs: nowMs, reportedAtMs: null });
  },
  listTrackedAccounts: async () => db.tracked,
  markAccountsReported: async (ids: string[]) => void db.reported.push(...ids),
  eraseAccount: async (id: string) => void db.erased.push(id),
  refreshAccount: async (id: string) => void db.refreshed.push(id),
}));

const { runPrivacyUpkeep } = await import('../../src/forge/jobs/privacy');

beforeEach(() => {
  db.stored = [];
  db.tracked = [];
  db.snapshots = [];
  db.replaced.clear();
  db.reported = [];
  db.erased = [];
  db.refreshed = [];
  db.purgedBefore = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('runPrivacyUpkeep', () => {
  it('reports new and week-old accounts with the time Covenant first stored them, and skips the rest', async () => {
    db.stored = ['new-account', 'erased', 'unknown'];
    db.tracked = [
      { accountId: 'reported-yesterday', storedAtMs: NOW - 30 * DAY, reportedAtMs: NOW - DAY },
      { accountId: 'reported-last-week', storedAtMs: NOW - 30 * DAY, reportedAtMs: NOW - 8 * DAY },
    ];
    const sent: Array<{ accountId: string; updatedAt: string }> = [];
    const summary = await runPrivacyUpkeep(NOW, async (accounts) => {
      sent.push(...accounts);
      return [];
    });
    expect(sent).toEqual([
      { accountId: 'new-account', updatedAt: new Date(NOW).toISOString() },
      { accountId: 'reported-last-week', updatedAt: new Date(NOW - 30 * DAY).toISOString() },
    ]);
    expect(db.reported).toEqual(['new-account', 'reported-last-week']);
    expect(summary).toMatchObject({ tracked: 3, reported: 2, closed: 0, updated: 0, reportFailed: false });
  });

  it('erases closed accounts and refreshes changed ones', async () => {
    db.stored = ['closed-one', 'changed-one', 'same-one'];
    const summary = await runPrivacyUpkeep(NOW, async () => [
      { accountId: 'closed-one', status: 'closed' },
      { accountId: 'changed-one', status: 'updated' },
    ]);
    expect(db.erased).toEqual(['closed-one']);
    expect(db.refreshed).toEqual(['changed-one']);
    expect(summary).toMatchObject({ reported: 3, closed: 1, updated: 1 });
  });

  it('keeps going when the reporting call fails, and tries again next run', async () => {
    db.stored = ['a'];
    const summary = await runPrivacyUpkeep(NOW, async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    });
    expect(summary.reportFailed).toBe(true);
    expect(db.reported).toEqual([]);
    expect(db.tracked[0]?.reportedAtMs).toBeNull();
  });

  it('makes no call when nothing is due', async () => {
    const report = vi.fn(async () => []);
    await runPrivacyUpkeep(NOW, report);
    expect(report).not.toHaveBeenCalled();
  });

  it('takes the people out of old decision snapshots and deletes expired context', async () => {
    db.snapshots = [
      { id: 'd1', brief: { context: { related: [], goals: [], teams: [], owners: [{ accountId: 'x', name: 'Alex Doe' }], problems: [] } } },
      { id: 'd2', brief: { context: null } },
    ];
    const summary = await runPrivacyUpkeep(NOW, async () => []);
    expect(db.replaced.get('d1')).toEqual({ context: { related: [], goals: [], teams: [], suggestedOwners: 1, problems: [] } });
    expect(db.replaced.has('d2')).toBe(false);
    expect(summary.scrubbedSnapshots).toBe(1);
    expect(db.purgedBefore).toEqual([NOW - 60 * 60 * 1000]);
  });
});
