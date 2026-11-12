import { randomUUID } from 'node:crypto';
import { type AdfDoc, parseDecisionInput, rolloverCheck } from '../../../packages/core/src';
import { dueDateOf, scheduleFor, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError, readableError } from '../errors';
import { addComment, asUser, updateDueDate } from '../jira';
import { getLeadDays } from '../settings';
import { OUTCOME_LABELS, ROLLOVER_BLOCKED_TEXT } from '../text';
import { buildBrief } from './brief';

/**
 * Decisions and renewals. Every action runs as the signed-in user, checks the
 * contract belongs to the work item the panel is on, and changes state with a
 * conditional update.
 */

export interface Bundle {
  contract: repo.ContractRow;
  run: repo.RunRow;
  obligations: repo.ObligationRow[];
  clauses: Map<string, repo.ClauseRow>;
  state: repo.ContractState;
  decisions: repo.DecisionRow[];
}

export async function loadBundle(issueId: string, contractId: string): Promise<Bundle> {
  await ensureSchema();
  const contract = await repo.getContract(contractId);
  if (contract === null) throw new UserFacingError('That contract no longer exists. Reload the panel.');
  if (contract.issueId !== issueId) throw new UserFacingError('That contract belongs to a different work item.');
  const run = await repo.latestRun(contract.id);
  if (run === null || (run.status !== 'needs_review' && run.status !== 'approved')) {
    throw new UserFacingError('This contract has not finished extraction yet.');
  }
  const [obligations, clauses, state, decisions] = await Promise.all([
    repo.listObligations(run.id),
    repo.listClauses(run.id),
    repo.getContractState(contract.id),
    repo.listDecisionsForContract(contract.id),
  ]);
  return { contract, run, obligations, clauses: new Map(clauses.map((c) => [c.id, c])), state, decisions };
}

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

export async function recordDecision(issueId: string, contractId: string, input: unknown, accountId: string): Promise<{ id: string; commentedOn: string | null }> {
  const parsed = parseDecisionInput(input);
  if (!parsed.ok) throw new UserFacingError(`Not recorded: ${parsed.problems.join('; ')}`);
  const bundle = await loadBundle(issueId, contractId);
  const today = todayUtc();
  const brief = buildBrief({ ...bundle, today, leadDays: await getLeadDays() });
  const now = Date.now();

  // The snapshot is what the decision was made on: the brief as shown, and every obligation's state and date.
  const snapshot = {
    takenAt: today,
    fileName: bundle.contract.fileName,
    issueKey: bundle.contract.issueKey,
    terms: bundle.run.terms,
    autoRenew: bundle.run.autoRenew,
    termNumber: brief.termNumber,
    window: brief.window,
    clauses: brief.clauses,
    obligations: bundle.obligations
      .filter((o) => o.decision !== 'rejected')
      .map((o) => {
        const s = scheduleFor(o.rule, bundle.run, bundle.contract, o.eventDate, today);
        return { kind: o.rule.kind, summary: o.rule.summary, decision: o.decision, due: dueDateOf(s), workItemKey: o.workItemKey };
      }),
    extractorVersion: bundle.run.extractorVersion,
    model: bundle.run.model,
    // The related work, goals and owners this person last saw, if they opened them.
    context: (await repo.getCachedContext(bundle.contract.id, accountId))?.payload ?? null,
  };

  const id = randomUUID();
  await repo.insertDecision({
    id,
    contractId: bundle.contract.id,
    runId: bundle.run.id,
    outcome: parsed.value.outcome,
    rationale: parsed.value.rationale,
    brief: snapshot,
    termIndex: bundle.contract.termIndex,
    workItemKey: bundle.state.decisionItemKey,
    decidedBy: accountId,
    decidedAtMs: now,
  });

  // Leave the decision on the "Decision due" item too, so it reads complete in Jira. A failure here does not undo the record.
  let commentedOn: string | null = null;
  if (bundle.state.decisionItemKey !== null) {
    const body: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        paragraph(`Decision recorded in Covenant: ${OUTCOME_LABELS[parsed.value.outcome] ?? parsed.value.outcome}.`),
        paragraph(`Rationale: ${parsed.value.rationale}`),
      ],
    };
    try {
      await addComment(asUser(), bundle.state.decisionItemKey, body);
      commentedOn = bundle.state.decisionItemKey;
    } catch (error) {
      console.error(`decision ${id} comment failed error=${loggableError(error)}`);
    }
  }
  console.log(`decision ${id} recorded contract=${bundle.contract.id} outcome=${parsed.value.outcome} term=${bundle.contract.termIndex}`);
  return { id, commentedOn };
}

async function refreshUndecidedSchedules(bundle: Bundle, contract: repo.ContractRow): Promise<void> {
  const today = todayUtc();
  const now = Date.now();
  for (const o of bundle.obligations) {
    if (o.decision !== 'pending' && o.decision !== 'edited') continue;
    const s = scheduleFor(o.rule, bundle.run, contract, o.eventDate, today);
    await repo.saveSchedule(o.id, dueDateOf(s), s.status, now);
  }
}

export interface RenewResult {
  termNumber: number;
  moved: Array<{ label: string; before: string | null; after: string | null }>;
}

/** Marks the contract renewed: the next term starts and every date that hangs from the term moves with it. */
export async function markRenewed(issueId: string, contractId: string, fromTermIndex: number, accountId: string): Promise<RenewResult> {
  const bundle = await loadBundle(issueId, contractId);
  if (bundle.contract.termIndex !== fromTermIndex) throw new UserFacingError('The contract changed meanwhile. Reload the panel.');
  const terms = bundle.run.terms ?? { effectiveDate: null, initialTerm: null, initialTermEnd: null, renewalTerm: null };
  const check = rolloverCheck(terms, fromTermIndex);
  if (!check.ok) throw new UserFacingError(ROLLOVER_BLOCKED_TEXT[check.reason] ?? `It cannot be marked renewed: ${check.detail}.`);

  const brief = buildBrief({ ...bundle, today: todayUtc(), leadDays: await getLeadDays() });
  if (!(await repo.setTermIndex(bundle.contract.id, fromTermIndex, fromTermIndex + 1))) {
    throw new UserFacingError('The contract changed meanwhile. Reload the panel.');
  }
  await repo.recordRenewal(bundle.contract.id, accountId, Date.now());
  await refreshUndecidedSchedules(bundle, { ...bundle.contract, termIndex: fromTermIndex + 1 });
  console.log(`contract ${bundle.contract.id} renewed term=${fromTermIndex + 1} moved=${brief.shifts.length}`);
  return { termNumber: check.next.number, moved: brief.shifts.map((s) => ({ label: s.label, before: s.before, after: s.after })) };
}

export async function undoRenewal(issueId: string, contractId: string, fromTermIndex: number): Promise<void> {
  const bundle = await loadBundle(issueId, contractId);
  if (fromTermIndex < 1 || bundle.contract.termIndex !== fromTermIndex) throw new UserFacingError('The contract changed meanwhile. Reload the panel.');
  if (!(await repo.setTermIndex(bundle.contract.id, fromTermIndex, fromTermIndex - 1))) {
    throw new UserFacingError('The contract changed meanwhile. Reload the panel.');
  }
  await repo.recordRenewal(bundle.contract.id, null, null);
  await refreshUndecidedSchedules(bundle, { ...bundle.contract, termIndex: fromTermIndex - 1 });
  console.log(`contract ${bundle.contract.id} renewal undone term=${fromTermIndex - 1}`);
}

export interface MoveResult {
  moved: string[];
  failed: Array<{ key: string; error: string }>;
}

/** Moves approved work items to the due dates the contract now gives, after a person asked for it. */
export async function moveWorkItemDates(issueId: string, contractId: string): Promise<MoveResult> {
  const bundle = await loadBundle(issueId, contractId);
  const brief = buildBrief({ ...bundle, today: todayUtc(), leadDays: await getLeadDays() });
  const req = asUser();
  const result: MoveResult = { moved: [], failed: [] };
  for (const stale of brief.staleWorkItems) {
    const o = bundle.obligations.find((x) => x.id === stale.obligationId);
    if (o === undefined) continue;
    try {
      await updateDueDate(req, stale.workItemKey, stale.current);
      const s = scheduleFor(o.rule, bundle.run, bundle.contract, o.eventDate, todayUtc());
      await repo.saveApprovedDueDate(o.id, stale.current, s.status, Date.now());
      result.moved.push(stale.workItemKey);
    } catch (error) {
      result.failed.push({ key: stale.workItemKey, error: readableError(error, `Could not move ${stale.workItemKey}`) });
    }
  }
  console.log(`contract ${bundle.contract.id} moved work item dates moved=${result.moved.length} failed=${result.failed.length}`);
  return result;
}
