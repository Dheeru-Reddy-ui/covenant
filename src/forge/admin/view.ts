import baseline from '../../../eval/baseline.json';
import { KIND_LABELS, MAX_DECISION_LEAD_DAYS, MIN_DECISION_LEAD_DAYS, type ObligationKind } from '../../../packages/core/src';
import * as repo from '../db/repo';
import { ACCESS_KEEP_MS } from '../jobs/privacy';
import type { AdminView, SampleStatus } from '../../shared/admin';
import { ensureSchema } from '../db/schema';
import { UserFacingError } from '../errors';
import { asUser, isJiraAdmin, listCreatableProjects } from '../jira';
import type { DailySummary } from '../jobs/daily';
import { DAILY_LAST_RUN, SAMPLE_WORKSPACE, getJson, getLeadDays } from '../settings';
import { APP_ID } from './preflight';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shown as "(extraction ...)" beside each sample contract. */
const RUN_LABELS: Record<repo.RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  needs_review: 'done, ready for review',
  approved: 'done',
  failed: 'failed',
};

/** The admin page lives in Jira settings, but its resolvers check for themselves that the caller is a Jira administrator. */
export async function requireAdmin(): Promise<void> {
  if (!(await isJiraAdmin(asUser()))) throw new UserFacingError("Only Jira administrators can use Covenant's admin page.");
}

export async function loadAdmin(): Promise<AdminView> {
  await requireAdmin();
  await ensureSchema();
  const [leadDays, last, projects, sample, approvals, recent, last30Days] = await Promise.all([
    getLeadDays(),
    getJson<DailySummary>(DAILY_LAST_RUN),
    listCreatableProjects(asUser()),
    getJson<SampleStatus>(SAMPLE_WORKSPACE),
    repo.approvalQuality(),
    repo.listAccess(50),
    repo.countAccessByChannel(Date.now() - 30 * DAY_MS),
  ]);
  // The sample status records what happened when it was loaded; show each extraction as it stands now.
  if (sample !== null && sample.contracts.length > 0) {
    const runs = await repo.latestRunStatusByIssueKey(sample.contracts.map((c) => c.key));
    sample.contracts = sample.contracts.map((c) => {
      const status = runs.get(c.key);
      return status === undefined ? c : { ...c, extraction: RUN_LABELS[status] };
    });
  }
  return {
    leadDays,
    minLeadDays: MIN_DECISION_LEAD_DAYS,
    maxLeadDays: MAX_DECISION_LEAD_DAYS,
    lastDailyRun: last === null ? null : { atMs: last.atMs, source: last.source, contracts: last.contracts, due: last.due, opened: last.opened, failed: last.failed },
    projects,
    sample,
    appId: APP_ID,
    quality: {
      eval: { ...baseline.eval, ...baseline.recorded },
      traps: baseline.traps,
      approvals,
    },
    access: {
      last30Days,
      recent: recent.map((r) => ({
        accountId: r.accountId,
        channel: r.channel,
        action: r.action,
        obligationId: r.obligationId,
        kindLabel: r.kind && r.kind in KIND_LABELS ? KIND_LABELS[r.kind as ObligationKind] : null,
        issueKey: r.issueKey,
        atMs: r.atMs,
      })),
      keepDays: Math.round(ACCESS_KEEP_MS / DAY_MS),
    },
  };
}
