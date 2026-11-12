import { type IsoDate, KIND_LABELS, type Schedule, type ToolItem, describeTiming, registerRows } from '../../../packages/core/src';
import type { RegisterRowView, RegisterView } from '../../shared/register';
import { dueDateOf, scheduleFor } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { type FoundIssue, type IssueHeader, type Person, asUser, issueHeader, searchIssues } from '../jira';
import { getLeadDays } from '../settings';

/**
 * The portfolio: every obligation on the contracts this person can see.
 * Covenant's tables hold every contract on the site, so it first asks Jira, as
 * the viewer, which contract work items they can see, and keeps only those.
 * Owners are the assignees of the approved child work items. Dates are worked
 * out fresh, because today moves. The register page and the Rovo and MCP tools
 * both read it.
 */

const CONCURRENCY = 8;

export interface PortfolioItem extends ToolItem {
  obligation: repo.ObligationRow;
  run: repo.RunRow;
  contract: repo.ContractRow;
  /** The contract's work item as Jira shows it now: its key may have changed since extraction. */
  issue: IssueHeader;
  /** The schedule worked out today, or null for an approved one-off obligation, which keeps its work item's date. */
  schedule: Schedule | null;
  owner: Person | null;
}

export interface Portfolio {
  today: IsoDate;
  leadDays: number;
  items: PortfolioItem[];
  contractsShown: number;
  /** Contracts on work items this person cannot see. */
  hiddenContracts: number;
}

async function visibleIssues(issueIds: string[]): Promise<Map<string, IssueHeader>> {
  const req = asUser();
  const visible = new Map<string, IssueHeader>();
  for (let i = 0; i < issueIds.length; i += CONCURRENCY) {
    const batch = issueIds.slice(i, i + CONCURRENCY);
    const seen = await Promise.all(batch.map((id) => issueHeader(req, id)));
    for (const issue of seen) if (issue !== null) visible.set(issue.id, issue);
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

/** `today` is on the viewer's calendar (see todayIn). */
export async function loadPortfolio(today: IsoDate): Promise<Portfolio> {
  await ensureSchema();
  const [runs, contractList, leadDays] = await Promise.all([repo.listLatestReviewableRuns(), repo.listAllContracts(), getLeadDays()]);
  const contracts = new Map(contractList.map((c) => [c.id, c]));

  const candidates = runs.map((r) => contracts.get(r.contractId)).filter((c): c is repo.ContractRow => c !== undefined);
  const visible = await visibleIssues([...new Set(candidates.map((c) => c.issueId))]);
  const shownRuns = runs.filter((r) => {
    const c = contracts.get(r.contractId);
    return c !== undefined && visible.has(c.issueId);
  });
  const runsById = new Map(shownRuns.map((r) => [r.id, r]));

  const obligations = await repo.listObligationsForRuns(shownRuns.map((r) => r.id));
  const children = await childrenOf([...visible.keys()]);

  const items = obligations.flatMap((o): PortfolioItem[] => {
    const run = runsById.get(o.runId);
    const contract = run ? contracts.get(run.contractId) : undefined;
    const issue = contract ? visible.get(contract.issueId) : undefined;
    if (run === undefined || contract === undefined || issue === undefined) return [];
    // An approved one-off obligation shows the date on its work item; recurring ones show their next occurrence.
    const schedule = o.decision === 'approved' && o.rule.recurrence === null ? null : scheduleFor(o.rule, run, contract, o.eventDate, today);
    const owner = (o.workItemKey ? children.get(o.workItemKey)?.assignee : null) ?? null;
    return [
      {
        obligation: o,
        run,
        contract,
        issue,
        schedule,
        owner,
        kind: o.rule.kind,
        party: o.rule.responsibleParty,
        contractNames: [issue.key, issue.summary, contract.fileName],
        due: schedule === null ? o.dueDate : dueDateOf(schedule),
        scheduleStatus: schedule === null ? o.scheduleStatus : schedule.status,
        hasOwner: owner !== null,
        decision: o.decision,
      },
    ];
  });

  return { today, leadDays, items, contractsShown: shownRuns.length, hiddenContracts: candidates.length - shownRuns.length };
}

export async function loadRegister(windowDays: number | null, today: IsoDate): Promise<RegisterView> {
  const portfolio = await loadPortfolio(today);
  const rows: RegisterRowView[] = registerRows(portfolio.items, { today: portfolio.today, windowDays, noticeLeadDays: portfolio.leadDays }).map(
    (r) => ({
      obligationId: r.obligation.id,
      contractId: r.contract.id,
      issueKey: r.issue.key,
      fileName: r.contract.fileName,
      kind: r.kind,
      kindLabel: KIND_LABELS[r.kind],
      summary: r.obligation.rule.summary,
      party: r.party,
      timing: describeTiming(r.obligation.rule),
      due: r.due,
      daysLeft: r.daysLeft,
      scheduleStatus: r.scheduleStatus,
      decision: r.decision,
      workItemKey: r.obligation.workItemKey,
      owner: r.owner === null ? null : { accountId: r.owner.accountId, displayName: r.owner.displayName },
      flags: r.flags,
    }),
  );
  return {
    today: portfolio.today,
    windowDays,
    leadDays: portfolio.leadDays,
    rows,
    counts: {
      contracts: portfolio.contractsShown,
      insideNoticeWindow: rows.filter((r) => r.flags.insideNoticeWindow).length,
      noOwner: rows.filter((r) => r.flags.noOwner).length,
      overdue: rows.filter((r) => r.flags.overdue).length,
    },
    hiddenContracts: portfolio.hiddenContracts,
  };
}
