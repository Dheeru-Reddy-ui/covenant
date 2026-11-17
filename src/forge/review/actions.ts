import {
  type IsoDate,
  type ObligationEdit,
  applyObligationEdit,
  canApprove,
  draftWorkItem,
  isValidIsoDate,
  parseTermsEdit,
  runReviewStatus,
} from '../../../packages/core/src';
import { dueDateOf, nextAfterWorkItem, scheduleFor, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError, readableError } from '../errors';
import { asUser, childIssueType, createChild, editIssue, getIssue } from '../jira';

/**
 * What a reviewer does in the panel. Every action runs as the signed-in user,
 * checks that the item belongs to the work item the panel is on, and changes
 * state with a conditional update, so a double click or two reviewers at once
 * cannot create a second work item.
 */

/** An approval claim older than this belonged to a call that died part way. */
const STALE_APPROVAL_MS = 2 * 60 * 1000;

interface Loaded {
  obligation: repo.ObligationRow;
  run: repo.RunRow;
  contract: repo.ContractRow;
}

async function loadOwned(issueId: string, obligationId: string): Promise<Loaded> {
  await ensureSchema();
  const obligation = await repo.getObligation(obligationId);
  if (obligation === null) throw new UserFacingError('That obligation no longer exists. Reload the panel.');
  const [run, contract] = await Promise.all([repo.getRun(obligation.runId), repo.getContract(obligation.contractId)]);
  if (run === null || contract === null) throw new UserFacingError('That obligation no longer exists. Reload the panel.');
  if (contract.issueId !== issueId) throw new UserFacingError('That obligation belongs to a different work item.');
  return { obligation, run, contract };
}

async function refreshRunStatus(runId: string): Promise<void> {
  await repo.setReviewStatus(runId, runReviewStatus(await repo.listDecisions(runId)), Date.now());
}

export interface ApproveResult {
  workItemKey: string;
  dueDate: IsoDate | null;
  dueDateSet: boolean;
}

export async function approveObligation(issueId: string, obligationId: string, accountId: string): Promise<ApproveResult> {
  const started = Date.now();
  const { obligation, run, contract } = await loadOwned(issueId, obligationId);
  if (obligation.decision === 'approved' && obligation.workItemKey !== null) {
    return { workItemKey: obligation.workItemKey, dueDate: obligation.dueDate, dueDateSet: obligation.dueDate !== null };
  }
  if (!canApprove({ decision: obligation.decision, extractorStatus: obligation.extractorStatus })) {
    if (obligation.decision === 'approving') throw new UserFacingError('This obligation is already being approved.');
    if (obligation.decision === 'rejected') throw new UserFacingError('This obligation was rejected. Undo the rejection first.');
    throw new UserFacingError('Covenant marked this obligation for review. Open it with Edit, check it, and save it before approving.');
  }

  const backTo = obligation.decision === 'edited' ? 'edited' : 'pending';
  if (!(await repo.claimForApproval(obligation.id, started, started - STALE_APPROVAL_MS))) {
    throw new UserFacingError('This obligation is already being approved.');
  }

  try {
    const clause = await repo.getClause(obligation.clauseId);
    if (clause === null) throw new Error('clause not found');
    const schedule = scheduleFor(obligation.rule, run, contract, obligation.eventDate, todayUtc());
    const draft = draftWorkItem({
      rule: obligation.rule,
      schedule,
      location: { page: clause.page, pageEnd: clause.pageEnd, paginated: run.paginated, section: clause.section },
      source: { fileName: contract.fileName, parentKey: contract.issueKey },
    });

    const req = asUser();
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

    await repo.markApproved(obligation.id, created, draft.dueDate, schedule.status, accountId, Date.now());
    await repo.recordCreatedItem(created.key, contract.id, 'obligation', Date.now());
    await refreshRunStatus(run.id);
    console.log(
      `obligation ${obligation.id} approved run=${run.id} workItem=${created.key} type=${type.id} schedule=${schedule.status} ` +
        `dueDateSet=${created.dueDateSet} ms=${Date.now() - started}`,
    );
    return { workItemKey: created.key, dueDate: draft.dueDate, dueDateSet: created.dueDateSet };
  } catch (error) {
    console.error(`obligation ${obligation.id} approval failed error=${loggableError(error)} ms=${Date.now() - started}`);
    const message = readableError(error, 'Covenant could not create the work item. Try again.');
    await repo.releaseApproval(obligation.id, backTo, message, Date.now());
    throw new UserFacingError(message);
  }
}

export interface NextWorkItemResult {
  key: string;
  dueDate: IsoDate | null;
  created: boolean;
  /** The finished item's assignee was given the new one too. */
  assigned: boolean;
}

/**
 * A recurring obligation's work item covers one date. Once a person has
 * finished it in Jira, their click on that item opens the work item for the
 * next date under the contract, as that person, with the same assignee, and
 * the obligation moves to it. The finished item keeps its Covenant panel. A
 * second click, or a click on an earlier item, gives back the one already open.
 */
export async function openNextWorkItem(issueId: string): Promise<NextWorkItemResult> {
  const started = Date.now();
  await ensureSchema();
  const obligation = await repo.findObligationByWorkItem(issueId);
  if (obligation === null) throw new UserFacingError('This work item is not one Covenant created for an approved obligation.');
  if (obligation.workItemId !== issueId && obligation.workItemKey !== null) {
    return { key: obligation.workItemKey, dueDate: obligation.dueDate, created: false, assigned: false };
  }
  if (obligation.rule.recurrence === null) throw new UserFacingError('This obligation falls due once, so there is no next date to open.');
  const [run, contract, clause] = await Promise.all([repo.getRun(obligation.runId), repo.getContract(obligation.contractId), repo.getClause(obligation.clauseId)]);
  if (run === null || contract === null || clause === null) throw new UserFacingError('That obligation no longer exists. Reload the panel.');

  const req = asUser();
  const finished = await getIssue(req, issueId);
  if (finished.statusCategory !== 'done') throw new UserFacingError(`Finish ${finished.key} in Jira first. Covenant then opens the work item for the next date.`);
  const schedule = nextAfterWorkItem(obligation.rule, run, contract, obligation.eventDate, finished.dueDate, todayUtc());
  if (schedule === null) throw new UserFacingError('The contract gives no later date for this obligation, so there is nothing to open.');

  if (!(await repo.claimWorkItemMove(obligation.id, { id: finished.id, key: finished.key }, finished.dueDate, started))) {
    throw new UserFacingError('The next work item is already being opened. Reload the panel in a moment.');
  }
  try {
    const draft = draftWorkItem({
      rule: obligation.rule,
      schedule,
      location: { page: clause.page, pageEnd: clause.pageEnd, paginated: run.paginated, section: clause.section },
      source: { fileName: contract.fileName, parentKey: contract.issueKey },
    });
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
    await repo.recordCreatedItem(created.key, contract.id, 'obligation', Date.now());
    await repo.moveToNextWorkItem(obligation.id, finished.id, created, draft.dueDate, schedule.status, Date.now());

    // Whoever did this date is the likely owner of the next. A failure leaves it unassigned, which the register flags.
    let assigned = false;
    if (finished.assigneeId !== null) {
      try {
        await editIssue(req, created.key, { assignee: { accountId: finished.assigneeId } });
        assigned = true;
      } catch (error) {
        console.error(`obligation ${obligation.id} next work item assign failed error=${loggableError(error)}`);
      }
    }
    console.log(`obligation ${obligation.id} moved workItem=${finished.key} next=${created.key} assigned=${assigned} ms=${Date.now() - started}`);
    return { key: created.key, dueDate: draft.dueDate, created: true, assigned };
  } catch (error) {
    await repo.releaseWorkItemMove(finished.id);
    console.error(`obligation ${obligation.id} next work item failed error=${loggableError(error)} ms=${Date.now() - started}`);
    throw new UserFacingError(readableError(error, 'Covenant could not open the next work item. Try again.'));
  }
}

export async function rejectObligation(issueId: string, obligationId: string, accountId: string): Promise<void> {
  const { obligation, run } = await loadOwned(issueId, obligationId);
  if (!(await repo.rejectObligation(obligation.id, accountId, Date.now()))) {
    throw new UserFacingError('Only an obligation that is waiting for review can be rejected.');
  }
  await refreshRunStatus(run.id);
  console.log(`obligation ${obligation.id} rejected run=${run.id}`);
}

export async function reopenObligation(issueId: string, obligationId: string): Promise<void> {
  const { obligation, run } = await loadOwned(issueId, obligationId);
  if (!(await repo.reopenObligation(obligation.id, Date.now()))) throw new UserFacingError('Only a rejected obligation can be reopened.');
  await refreshRunStatus(run.id);
  console.log(`obligation ${obligation.id} reopened run=${run.id}`);
}

export interface EditRequest extends ObligationEdit {
  eventDate?: string | null;
}

export async function editObligation(issueId: string, obligationId: string, edit: EditRequest): Promise<void> {
  const { obligation, run, contract } = await loadOwned(issueId, obligationId);
  if (obligation.decision !== 'pending' && obligation.decision !== 'edited') {
    throw new UserFacingError('Only an obligation that is waiting for review can be edited.');
  }
  const { eventDate: eventInput, ...ruleEdit } = edit;
  const result = applyObligationEdit(obligation.rule, ruleEdit);
  if (!result.ok) throw new UserFacingError(`Not saved: ${result.problems.join('; ')}`);

  let eventDate: IsoDate | null = null;
  if (result.rule.anchor === 'event') {
    const typed = eventInput === undefined ? obligation.eventDate : eventInput;
    if (typed !== null && typed !== '' && !isValidIsoDate(typed)) throw new UserFacingError('Not saved: the event date must be a real date.');
    eventDate = typed === '' ? null : (typed ?? null);
  }

  const schedule = scheduleFor(result.rule, run, contract, eventDate, todayUtc());
  if (!(await repo.saveEdit(obligation.id, result.rule, eventDate, dueDateOf(schedule), schedule.status, Date.now()))) {
    throw new UserFacingError('Not saved: this obligation was decided meanwhile. Reload the panel.');
  }
  console.log(`obligation ${obligation.id} edited run=${run.id} schedule=${schedule.status}`);
}

export interface TermsRequest {
  terms: unknown;
  autoRenew: boolean;
}

export async function editTerms(issueId: string, runId: string, request: TermsRequest, accountId: string): Promise<void> {
  await ensureSchema();
  const run = await repo.getRun(runId);
  const contract = run === null ? null : await repo.getContract(run.contractId);
  if (run === null || contract === null) throw new UserFacingError('That extraction no longer exists. Reload the panel.');
  if (contract.issueId !== issueId) throw new UserFacingError('That contract belongs to a different work item.');
  if (run.status !== 'needs_review' && run.status !== 'approved') throw new UserFacingError('The term facts can be edited once extraction has finished.');

  const parsed = parseTermsEdit(request.terms);
  if (!parsed.ok) throw new UserFacingError(`Not saved: ${parsed.problems.join('; ')}`);
  const before = run.terms ?? { effectiveDate: null, initialTerm: null, initialTermEnd: null, renewalTerm: null };
  const after = parsed.terms;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  const now = Date.now();
  const previous = run.facts;
  const mark = <V>(fact: repo.StoredFact<V> | undefined, changed: boolean): repo.StoredFact<V> => {
    const base: repo.StoredFact<V> = fact ?? { status: 'missing', value: null, clauseId: null, confidence: null, review: [], secondReading: null };
    return changed ? { ...base, status: 'edited' } : base;
  };
  const facts: repo.StoredFacts = {
    effectiveDate: mark(previous?.effectiveDate, !same(before.effectiveDate, after.effectiveDate)),
    term: mark(previous?.term, !same(before.initialTerm, after.initialTerm) || !same(before.initialTermEnd, after.initialTermEnd)),
    renewal: mark(previous?.renewal, !same(before.renewalTerm, after.renewalTerm) || run.autoRenew !== request.autoRenew),
    editedBy: accountId,
    editedAtMs: now,
  };
  await repo.updateRunTerms(run.id, facts, after, request.autoRenew, now);

  // Undecided obligations follow the new facts. Approved ones keep the work item they already have.
  const updated: repo.RunRow = { ...run, terms: after, autoRenew: request.autoRenew };
  const today = todayUtc();
  for (const o of await repo.listObligations(run.id)) {
    if (o.decision !== 'pending' && o.decision !== 'edited') continue;
    const schedule = scheduleFor(o.rule, updated, contract, o.eventDate, today);
    await repo.saveSchedule(o.id, dueDateOf(schedule), schedule.status, now);
  }
  console.log(`run ${run.id} terms edited`);
}
