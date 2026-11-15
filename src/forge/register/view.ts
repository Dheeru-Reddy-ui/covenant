import { type ContractLoad, type IsoDate, KIND_LABELS, type Schedule, type ToolItem, decisionForTerm, describeTiming, formatMoney, moneyAtStake, registerRows, renewalLoad } from '../../../packages/core/src';
import type { RegisterRowView, RegisterView } from '../../shared/register';
import { dueDateOf, scheduleFor } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { type FoundIssue, type IssueHeader, type Person, asUser, issueHeader, searchIssues } from '../jira';
import { confirmedYearlyValue } from '../details/service';
import { getLeadDays } from '../settings';
import { OUTCOME_LABELS } from '../text';

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
  /** For a notice deadline: the outcome already decided for its term, or null while a decision is still open. */
  decided: string | null;
}

export interface Portfolio {
  today: IsoDate;
  leadDays: number;
  items: PortfolioItem[];
  contractsShown: number;
  /** One entry per contract: its next notice deadline, whether it renews by itself, and its confirmed yearly value. */
  load: ContractLoad[];
  /** Contracts whose extracted value is still waiting for a person to confirm it. */
  valuesAwaiting: number;
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
  const decisions = await repo.listDecisionsForContracts(shownRuns.map((r) => r.contractId));

  const items = obligations.flatMap((o): PortfolioItem[] => {
    const run = runsById.get(o.runId);
    const contract = run ? contracts.get(run.contractId) : undefined;
    const issue = contract ? visible.get(contract.issueId) : undefined;
    if (run === undefined || contract === undefined || issue === undefined) return [];
    // An approved one-off obligation shows the date on its work item; recurring ones show their next occurrence.
    const schedule = o.decision === 'approved' && o.rule.recurrence === null ? null : scheduleFor(o.rule, run, contract, o.eventDate, today);
    const owner = (o.workItemKey ? children.get(o.workItemKey)?.assignee : null) ?? null;
    const noticeTerm = schedule !== null && schedule.status !== 'undated' && schedule.termIndex !== null ? schedule.termIndex : contract.termIndex;
    const decided =
      o.rule.kind === 'renewal_notice' ? (decisionForTerm(decisions.filter((d) => d.contractId === contract.id), noticeTerm)?.outcome ?? null) : null;
    return [
      {
        obligation: o,
        run,
        contract,
        issue,
        schedule,
        owner,
        decided,
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

  // Money and load: one line per contract. Only a value a person confirmed is counted; code does the sums.
  const valueRows = await repo.listDetailsForRuns(shownRuns.map((r) => r.id), 'contract_value');
  let valuesAwaiting = 0;
  const load: ContractLoad[] = shownRuns.map((run) => {
    const mine = valueRows.filter((d) => d.runId === run.id);
    const yearly = confirmedYearlyValue(mine);
    if (yearly === null && mine.some((d) => d.decision === 'pending')) valuesAwaiting += 1;
    const deadlines = items
      .filter((i) => i.run.id === run.id && i.kind === 'renewal_notice' && i.decision !== 'rejected' && i.scheduleStatus === 'upcoming' && i.due !== null)
      .map((i) => i.due as IsoDate)
      .sort();
    return { deadline: deadlines[0] ?? null, autoRenew: run.autoRenew, yearly };
  });

  return { today, leadDays, items, contractsShown: shownRuns.length, hiddenContracts: candidates.length - shownRuns.length, load, valuesAwaiting };
}

/** The headline: what renews by itself unless notice is given in the next 90 days. */
export function moneyView(portfolio: Portfolio): RegisterView['money'] {
  const stake = moneyAtStake(portfolio.load, portfolio.today, 90);
  return {
    days: 90,
    totals: stake.totals.map((t) => `${formatMoney({ minor: t.minor, currency: t.currency })} a year`),
    contracts: stake.contracts,
    unvalued: stake.unvalued,
    valuesAwaiting: portfolio.valuesAwaiting,
  };
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
      decided: r.decided === null ? null : (OUTCOME_LABELS[r.decided] ?? r.decided),
    }),
  );
  return {
    today: portfolio.today,
    windowDays,
    leadDays: portfolio.leadDays,
    rows,
    counts: {
      contracts: portfolio.contractsShown,
      insideNoticeWindow: rows.filter((r) => r.flags.insideNoticeWindow && r.decided === null).length,
      decided: rows.filter((r) => r.flags.insideNoticeWindow && r.decided !== null).length,
      noOwner: rows.filter((r) => r.flags.noOwner).length,
      overdue: rows.filter((r) => r.flags.overdue).length,
    },
    hiddenContracts: portfolio.hiddenContracts,
    money: moneyView(portfolio),
    load: renewalLoad(portfolio.load, portfolio.today).map((m) => ({ label: m.label, deadlines: m.deadlines, values: m.values.map((v) => ({ currency: v.currency, amount: v.minor / 100 })) })),
  };
}
