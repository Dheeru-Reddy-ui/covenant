import { describeTiming, draftDecisionItem } from '../../../packages/core/src';
import { dueDateOf, scheduleFor, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { windowFor } from '../decisions/brief';
import { loggableError } from '../errors';
import { asApp, childIssueType, createChild, getIssue } from '../jira';
import { DAILY_LAST_RUN, getLeadDays, putJson } from '../settings';
import { runPrivacyUpkeep } from './privacy';
import { backfillClauseSections } from './sections';

/**
 * The daily check. It recomputes every contract's notice window and stored due
 * dates, and opens one "Decision due" work item per contract and term once the
 * notice deadline comes inside the lead time. It runs as the app, with no user,
 * so it never calls Teamwork Graph.
 */

/** A claim on opening a decision item that never got its key is retried after this long. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

export interface DailySummary {
  atMs: number;
  source: 'schedule' | 'manual';
  contracts: number;
  due: number;
  opened: string[];
  failed: number;
  ms: number;
}

export async function runDailyCheck(source: DailySummary['source']): Promise<DailySummary> {
  const started = Date.now();
  await ensureSchema();
  const leadDays = await getLeadDays();
  const today = todayUtc();

  const runs = await repo.listLatestReviewableRuns();
  const contracts = new Map((await repo.listAllContracts()).map((c) => [c.id, c]));
  const runIds = runs.map((r) => r.id);
  const obligations = await repo.listObligationsForRuns(runIds);
  const clauses = new Map((await repo.listClausesForRuns(runIds)).map((c) => [c.id, c]));
  const states = await repo.listContractStates(runs.map((r) => r.contractId));

  const summary: DailySummary = { atMs: started, source, contracts: 0, due: 0, opened: [], failed: 0, ms: 0 };
  for (const run of runs) {
    const contract = contracts.get(run.contractId);
    if (contract === undefined) continue;
    summary.contracts += 1;
    const mine = obligations.filter((o) => o.runId === run.id);
    const now = Date.now();

    for (const o of mine) {
      if (o.decision !== 'pending' && o.decision !== 'edited') continue;
      const s = scheduleFor(o.rule, run, contract, o.eventDate, today);
      if (dueDateOf(s) !== o.dueDate || s.status !== o.scheduleStatus) await repo.saveSchedule(o.id, dueDateOf(s), s.status, now);
    }

    const win = windowFor(run, contract, mine, today, leadDays);
    await repo.saveWindow(contract.id, 'deadline' in win ? win.deadline : null, win.status, now);
    if (win.status !== 'due') continue;
    summary.due += 1;

    const termIndex = win.termIndex ?? contract.termIndex;
    const state = states.get(contract.id);
    if (state?.decisionItemTerm === termIndex && state.decisionItemKey !== null) continue;
    if (!(await repo.claimDecisionItem(contract.id, termIndex, now, now - STALE_CLAIM_MS))) continue;

    try {
      const notice = mine.find((o) => o.id === win.obligationId);
      const clause = notice ? clauses.get(notice.clauseId) : undefined;
      const draft = draftDecisionItem({
        fileName: contract.fileName,
        parentKey: contract.issueKey,
        deadline: win.deadline,
        daysLeft: win.daysLeft,
        termEnd: win.termEnd,
        timing: notice ? describeTiming(notice.rule) : 'the notice period in the contract',
        clause: clause ? { quote: clause.quote, page: clause.page, pageEnd: clause.pageEnd, paginated: run.paginated, section: clause.section } : null,
      });
      const req = asApp();
      const parent = await getIssue(req, contract.issueId);
      const type = await childIssueType(req, parent);
      const created = await createChild(req, {
        projectId: parent.projectId,
        parentKey: parent.key,
        issueTypeId: type.id,
        summary: draft.summary,
        description: draft.description,
        dueDate: draft.dueDate,
      });
      await repo.setDecisionItemKey(contract.id, termIndex, created.key);
      summary.opened.push(created.key);
      console.log(`daily decision item opened contract=${contract.id} term=${termIndex} workItem=${created.key} daysLeft=${win.daysLeft}`);
    } catch (error) {
      summary.failed += 1;
      await repo.releaseDecisionItem(contract.id, termIndex);
      console.error(`daily decision item failed contract=${contract.id} error=${loggableError(error)}`);
    }
  }

  // Older extractions get their clause numbers here, a few contracts a day. A failure must not stop the check.
  await backfillClauseSections().catch((error: unknown) => console.error(`sections backfill failed error=${loggableError(error)}`));
  // Personal data reporting and clean-up, as Atlassian's user privacy guidelines require.
  await runPrivacyUpkeep().catch((error: unknown) => console.error(`privacy upkeep failed error=${loggableError(error)}`));

  summary.ms = Date.now() - started;
  await putJson(DAILY_LAST_RUN, summary, null);
  console.log(
    `daily check ${source} contracts=${summary.contracts} due=${summary.due} opened=${summary.opened.length} failed=${summary.failed} ms=${summary.ms}`,
  );
  return summary;
}

/** The scheduled trigger. A throw would only be logged, so it is caught and logged here with counts. */
export async function dailyJob(): Promise<void> {
  try {
    await runDailyCheck('schedule');
  } catch (error) {
    console.error(`daily check failed error=${loggableError(error)}`);
  }
}
