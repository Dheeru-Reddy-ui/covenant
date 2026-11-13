import { privacy } from '@forge/api';
import { ERASED_ACCOUNT, accountsDue, depersonaliseSnapshot, isReportableAccount } from '../../../packages/core/src';
import * as repo from '../db/repo';
import { loggableError } from '../errors';

/**
 * Personal data upkeep, run by the daily check. Atlassian's user privacy
 * guidelines require an app that stores personal data to report the account
 * ids it holds through the personal data reporting API, at most once per
 * seven-day cycle each, and to erase the data of closed accounts and refresh
 * or erase the data of changed ones.
 *
 * Covenant stores account ids only: who extracted, approved, decided, renewed
 * or changed a setting. Names live only in the per-person context cache, which
 * is deleted once it expires, and decision snapshots no longer keep people.
 */

/** Cached context is served for an hour; anything older is deleted rather than kept. */
const CONTEXT_KEEP_MS = 60 * 60 * 1000;
const SNAPSHOTS_PER_RUN = 200;

export interface PrivacySummary {
  tracked: number;
  reported: number;
  closed: number;
  updated: number;
  scrubbedSnapshots: number;
  purgedContext: number;
  /** The reporting call failed; it is tried again on the next run. */
  reportFailed: boolean;
}

type Reporter = (accounts: Array<{ accountId: string; updatedAt: string }>) => Promise<Array<{ accountId: string; status: 'updated' | 'closed' }>>;

const describeFailure = (error: unknown): string => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? `HTTP ${status}` : loggableError(error);
};

export async function runPrivacyUpkeep(nowMs: number = Date.now(), report: Reporter = privacy.reportPersonalData): Promise<PrivacySummary> {
  const summary: PrivacySummary = { tracked: 0, reported: 0, closed: 0, updated: 0, scrubbedSnapshots: 0, purgedContext: 0, reportFailed: false };

  // Names out of decision snapshots recorded before snapshots stopped keeping people.
  for (const { id, brief } of await repo.listDecisionSnapshotsWithPeople(SNAPSHOTS_PER_RUN)) {
    const { value, changed } = depersonaliseSnapshot(brief);
    if (!changed) continue;
    await repo.replaceDecisionSnapshot(id, value);
    summary.scrubbedSnapshots += 1;
  }

  summary.purgedContext = await repo.purgeContextBefore(nowMs - CONTEXT_KEEP_MS);

  // Track every stored account id, then report the ones due this cycle.
  const stored = (await repo.listStoredAccountIds()).filter(isReportableAccount);
  await repo.trackAccounts(stored, nowMs);
  const tracked = await repo.listTrackedAccounts();
  summary.tracked = tracked.length;
  const due = accountsDue(tracked, nowMs);

  if (due.length > 0) {
    try {
      const updates = await report(due.map((a) => ({ accountId: a.accountId, updatedAt: new Date(a.storedAtMs).toISOString() })));
      await repo.markAccountsReported(
        due.map((a) => a.accountId),
        nowMs,
      );
      summary.reported = due.length;
      for (const u of updates) {
        if (!isReportableAccount(u.accountId)) continue;
        if (u.status === 'closed') {
          await repo.eraseAccount(u.accountId, ERASED_ACCOUNT, nowMs);
          summary.closed += 1;
        } else if (u.status === 'updated') {
          await repo.refreshAccount(u.accountId, nowMs);
          summary.updated += 1;
        }
      }
    } catch (error) {
      summary.reportFailed = true;
      console.error(`privacy report failed accounts=${due.length} error=${describeFailure(error)}`);
    }
  }

  console.log(
    `privacy upkeep tracked=${summary.tracked} reported=${summary.reported} closed=${summary.closed} updated=${summary.updated} ` +
      `scrubbedSnapshots=${summary.scrubbedSnapshots} purgedContext=${summary.purgedContext} reportFailed=${summary.reportFailed}`,
  );
  return summary;
}
