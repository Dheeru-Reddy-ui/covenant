import { KIND_LABELS, describeTiming, registerRows } from '../../../packages/core/src';
import type { RegisterRowView, RegisterView } from '../../shared/register';
import { dueDateOf, scheduleFor, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { type FoundIssue, asUser, canSeeIssue, searchIssues } from '../jira';
import { getLeadDays } from '../settings';

/**
 * The portfolio register. Covenant's tables hold every contract on the site,
 * so the register first asks Jira, as the viewer, which contract work items
 * they can see, and shows only those. Owners are the assignees of the approved
 * child work items. Dates are worked out fresh, because today moves.
 */

const CONCURRENCY = 8;

async function visibleIssueIds(issueIds: string[]): Promise<Set<string>> {
  const req = asUser();
  const visible = new Set<string>();
  for (let i = 0; i < issueIds.length; i += CONCURRENCY) {
    const batch = issueIds.slice(i, i + CONCURRENCY);
    const seen = await Promise.all(batch.map(async (id) => ((await canSeeIssue(req, id)) ? id : null)));
    for (const id of seen) if (id !== null) visible.add(id);
  }
  return visible;
}

async function childrenOf(parentIds: string[]): Promise<Map<string, FoundIssue>> {
  const byKey = new Map<string, FoundIssue>();
  for (let i = 0; i < parentIds.length; i += 50) {
    const chunk = parentIds.slice(i, i + 50);
    for (const issue of await searchIssues(asUser(), `parent in (${chunk.join(',')})`, 500)) byKey.set(issue.key, issue);
  }
  return byKey;
}

export async function loadRegister(windowDays: number | null): Promise<RegisterView> {
  await ensureSchema();
  const [runs, contractList, leadDays] = await Promise.all([repo.listLatestReviewableRuns(), repo.listAllContracts(), getLeadDays()]);
  const today = todayUtc();
  const contracts = new Map(contractList.map((c) => [c.id, c]));

  const candidates = runs.map((r) => contracts.get(r.contractId)).filter((c): c is repo.ContractRow => c !== undefined);
  const visible = await visibleIssueIds([...new Set(candidates.map((c) => c.issueId))]);
  const shownRuns = runs.filter((r) => {
    const c = contracts.get(r.contractId);
    return c !== undefined && visible.has(c.issueId);
  });

  const obligations = await repo.listObligationsForRuns(shownRuns.map((r) => r.id));
  const children = await childrenOf([...visible]);

  const items = obligations.flatMap((o) => {
    const run = shownRuns.find((r) => r.id === o.runId);
    const contract = run ? contracts.get(run.contractId) : undefined;
    if (run === undefined || contract === undefined) return [];
    const schedule =
      o.decision === 'approved' && o.rule.recurrence === null
        ? null
        : scheduleFor(o.rule, run, contract, o.eventDate, today);
    // An approved one-off obligation shows the date on its work item; recurring ones show their next occurrence.
    const due = schedule === null ? o.dueDate : dueDateOf(schedule);
    const scheduleStatus = schedule === null ? o.scheduleStatus : schedule.status;
    const workItem = o.workItemKey ? children.get(o.workItemKey) : undefined;
    const owner = workItem?.assignee ?? null;
    return [
      {
        obligationId: o.id,
        contractId: contract.id,
        issueKey: contract.issueKey,
        fileName: contract.fileName,
        kind: o.rule.kind,
        kindLabel: KIND_LABELS[o.rule.kind],
        summary: o.rule.summary,
        party: o.rule.responsibleParty,
        timing: describeTiming(o.rule),
        due,
        scheduleStatus,
        decision: o.decision,
        workItemKey: o.workItemKey,
        owner,
        hasOwner: owner !== null,
      },
    ];
  });

  const rows: RegisterRowView[] = registerRows(items, { today, windowDays, noticeLeadDays: leadDays }).map(({ hasOwner: _owned, ...row }) => row);
  return {
    today,
    windowDays,
    leadDays,
    rows,
    counts: {
      contracts: shownRuns.length,
      insideNoticeWindow: rows.filter((r) => r.flags.insideNoticeWindow).length,
      noOwner: rows.filter((r) => r.flags.noOwner).length,
      overdue: rows.filter((r) => r.flags.overdue).length,
    },
    hiddenContracts: candidates.length - shownRuns.length,
  };
}
