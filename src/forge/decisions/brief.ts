import {
  type IsoDate,
  KIND_LABELS,
  type NoticeRule,
  type NoticeWindow,
  canApprove,
  currentTermIndex,
  describeSection,
  describeTiming,
  normaliseWhitespace,
  noticeWindow,
  rolloverCheck,
  rolloverPreview,
  termBounds,
} from '../../../packages/core/src';
import type { BriefView, ClauseView } from '../../shared/panel';
import { scheduleFor } from '../dates';
import type * as repo from '../db/repo';
import { OUTCOME_LABELS, ROLLOVER_BLOCKED_TEXT, undatedText } from '../text';

/**
 * The renewal decision brief: the notice deadline and countdown, the terms,
 * the clauses that govern renewal, past decisions, and what marking the
 * contract renewed would move. Context from Teamwork Graph is loaded
 * separately, only when a person asks for it.
 */

const NO_TERMS = { effectiveDate: null, initialTerm: null, initialTermEnd: null, renewalTerm: null };

/**
 * Notice rules that may drive a deadline. A rule the extractor flagged and no
 * person has checked is left out: it could be wrong, and the brief says so.
 */
export function noticeRulesOf(obligations: readonly repo.ObligationRow[]): NoticeRule[] {
  return obligations
    .filter((o) => o.rule.kind === 'renewal_notice')
    .filter((o) => o.decision === 'approved' || o.decision === 'approving' || canApprove({ decision: o.decision, extractorStatus: o.extractorStatus }))
    .map((o) => ({ id: o.id, rule: o.rule }));
}

export function windowFor(
  run: repo.RunRow,
  contract: repo.ContractRow,
  obligations: readonly repo.ObligationRow[],
  today: IsoDate,
  leadDays: number,
): NoticeWindow {
  return noticeWindow(noticeRulesOf(obligations), {
    terms: run.terms ?? NO_TERMS,
    autoRenew: run.autoRenew,
    minTermIndex: contract.termIndex,
    today,
    leadDays,
  });
}

const clauseView = (clause: repo.ClauseRow | undefined, paginated: boolean): ClauseView | null =>
  clause === undefined
    ? null
    : {
        quote: clause.quote,
        page: clause.page,
        pageEnd: clause.pageEnd,
        paginated,
        ambiguous: clause.ambiguous,
        section: clause.section ? describeSection(clause.section) : null,
      };

export interface BriefInput {
  contract: repo.ContractRow;
  run: repo.RunRow;
  obligations: readonly repo.ObligationRow[];
  clauses: ReadonlyMap<string, repo.ClauseRow>;
  state: repo.ContractState;
  decisions: readonly repo.DecisionRow[];
  today: IsoDate;
  leadDays: number;
}

export function buildBrief(input: BriefInput): BriefView {
  const { contract, run, obligations, clauses, state, today, leadDays } = input;
  const terms = run.terms ?? NO_TERMS;
  const live = obligations.filter((o) => o.decision !== 'rejected');
  const win = windowFor(run, contract, obligations, today, leadDays);
  const flaggedNotice = obligations.some((o) => o.rule.kind === 'renewal_notice' && o.decision === 'pending' && o.extractorStatus === 'needs_review');

  let window: BriefView['window'];
  if (win.status === 'no_notice_rule') {
    window = {
      status: 'no_notice_rule',
      deadline: null,
      daysLeft: null,
      decisionOpensOn: null,
      termEnd: null,
      timing: null,
      note: flaggedNotice
        ? 'A notice clause was found but needs your review before Covenant counts down to it. Check it in the list below.'
        : 'Covenant found no notice clause for renewal or termination in this contract.',
    };
  } else if (win.status === 'undated') {
    const rule = obligations.find((o) => o.id === win.obligationId)?.rule;
    window = {
      status: 'undated',
      deadline: null,
      daysLeft: null,
      decisionOpensOn: null,
      termEnd: null,
      timing: rule ? describeTiming(rule) : null,
      note: undatedText(win.reason, win.detail),
    };
  } else {
    const rule = obligations.find((o) => o.id === win.obligationId)?.rule;
    window = {
      status: win.status,
      deadline: win.deadline,
      daysLeft: win.daysLeft,
      decisionOpensOn: win.decisionOpensOn,
      termEnd: win.termEnd,
      timing: rule ? describeTiming(rule) : null,
      note: null,
    };
  }

  let currentTerm: BriefView['currentTerm'] = null;
  let termNumber = contract.termIndex + 1;
  const index = currentTermIndex(terms, today, { autoRenew: run.autoRenew, minTermIndex: contract.termIndex });
  if (index.ok) {
    termNumber = index.value + 1;
    const bounds = termBounds(terms, index.value);
    if (bounds.ok) currentTerm = { start: bounds.value.start, end: bounds.value.end };
  }

  const check = rolloverCheck(terms, contract.termIndex);
  const nextTerm = check.ok ? { number: check.next.number, start: check.next.start, end: check.next.end } : null;
  const rolloverBlocked = check.ok ? null : (ROLLOVER_BLOCKED_TEXT[check.reason] ?? `It cannot be marked renewed: ${check.detail}.`);

  const governing: BriefView['clauses'] = [];
  const renewalClause = run.facts?.renewal.clauseId ? clauseView(clauses.get(run.facts.renewal.clauseId), run.paginated) : null;
  if (renewalClause) governing.push({ label: 'Renewal', clause: renewalClause });
  for (const o of live.filter((x) => x.rule.kind === 'renewal_notice')) {
    const c = clauseView(clauses.get(o.clauseId), run.paginated);
    if (c === null) continue;
    // The notice words are often part of the renewal sentence already quoted. Quote each passage once, the longer one.
    const overlapping = governing.find((g) => normaliseWhitespace(g.clause.quote).includes(normaliseWhitespace(c.quote)));
    if (overlapping) {
      if (overlapping.label === 'Renewal') overlapping.label = 'Renewal and notice';
      continue;
    }
    const contained = governing.findIndex((g) => normaliseWhitespace(c.quote).includes(normaliseWhitespace(g.clause.quote)));
    if (contained !== -1) governing[contained] = { label: 'Renewal and notice', clause: c };
    else governing.push({ label: 'Notice', clause: c });
  }

  const labelOf = (o: repo.ObligationRow) => `${KIND_LABELS[o.rule.kind]}: ${o.rule.summary.replace(/[.\s]+$/, '')}`;
  const shifts = check.ok
    ? rolloverPreview(
        live.map((o) => ({ id: o.id, rule: o.rule, eventDate: o.eventDate })),
        { terms, autoRenew: run.autoRenew, termIndex: contract.termIndex, today },
      )
        .filter((s) => s.changed)
        .map((s) => {
          const o = live.find((x) => x.id === s.id);
          return { obligationId: s.id, label: o ? labelOf(o) : s.id, before: s.before, after: s.after };
        })
    : [];

  const staleWorkItems: BriefView['staleWorkItems'] = [];
  for (const o of obligations) {
    if (o.decision !== 'approved' || o.workItemKey === null) continue;
    const schedule = scheduleFor(o.rule, run, contract, o.eventDate, today);
    const current = schedule.status === 'undated' ? null : schedule.due;
    // A date that merely moved on to the next occurrence of a recurring duty is not stale.
    if (o.rule.recurrence !== null) continue;
    if (current !== o.dueDate) staleWorkItems.push({ obligationId: o.id, workItemKey: o.workItemKey, stored: o.dueDate, current });
  }

  return {
    window,
    leadDays,
    autoRenew: run.autoRenew,
    termNumber,
    currentTerm,
    nextTerm,
    rolloverBlocked,
    canUndoRenewal: contract.termIndex > 0,
    renewedAtMs: state.renewedAtMs,
    clauses: governing,
    decisionItemKey: state.decisionItemKey,
    decisions: input.decisions.map((d) => ({
      id: d.id,
      outcome: d.outcome,
      outcomeLabel: OUTCOME_LABELS[d.outcome] ?? d.outcome,
      rationale: d.rationale ?? '',
      termNumber: d.termIndex + 1,
      decidedBy: d.decidedBy,
      decidedAtMs: d.decidedAtMs,
    })),
    shifts,
    staleWorkItems,
  };
}
