import { MAX_DECISION_LEAD_DAYS, MIN_DECISION_LEAD_DAYS } from '../../../packages/core/src';
import type { AdminView, SampleStatus } from '../../shared/admin';
import { ensureSchema } from '../db/schema';
import { UserFacingError } from '../errors';
import { asUser, isJiraAdmin, listCreatableProjects } from '../jira';
import type { DailySummary } from '../jobs/daily';
import { DAILY_LAST_RUN, SAMPLE_WORKSPACE, getJson, getLeadDays } from '../settings';
import { APP_ID } from './preflight';

/** The admin page lives in Jira settings, but its resolvers check for themselves that the caller is a Jira administrator. */
export async function requireAdmin(): Promise<void> {
  if (!(await isJiraAdmin(asUser()))) throw new UserFacingError("Only Jira administrators can use Covenant's admin page.");
}

export async function loadAdmin(): Promise<AdminView> {
  await requireAdmin();
  await ensureSchema();
  const [leadDays, last, projects, sample] = await Promise.all([
    getLeadDays(),
    getJson<DailySummary>(DAILY_LAST_RUN),
    listCreatableProjects(asUser()),
    getJson<SampleStatus>(SAMPLE_WORKSPACE),
  ]);
  return {
    leadDays,
    minLeadDays: MIN_DECISION_LEAD_DAYS,
    maxLeadDays: MAX_DECISION_LEAD_DAYS,
    lastDailyRun: last === null ? null : { atMs: last.atMs, source: last.source, contracts: last.contracts, due: last.due, opened: last.opened, failed: last.failed },
    projects,
    sample,
    appId: APP_ID,
  };
}
