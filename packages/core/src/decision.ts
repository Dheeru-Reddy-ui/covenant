import { z } from 'zod';
import { type IsoDate, addDays, compareDates, diffDays } from './dates/civil';
import type { RuleTiming, UnresolvedReason } from './dates/resolve';
import { type ContractTerms, type TermProblem, termBounds } from './dates/terms';
import { type Schedule, scheduleRule } from './schedule';

/**
 * The renewal decision: when notice must be given, how long is left, and what
 * marking the contract renewed would do to its dates. Today is passed in.
 */

export const DECISION_OUTCOMES = ['renew', 'renegotiate', 'terminate'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** Days before the notice deadline that a decision falls due. Configurable per site. */
export const DEFAULT_DECISION_LEAD_DAYS = 60;
export const MIN_DECISION_LEAD_DAYS = 7;
export const MAX_DECISION_LEAD_DAYS = 365;

export interface NoticeRule {
  id: string;
  rule: RuleTiming;
}

export interface WindowContext {
  terms: ContractTerms;
  autoRenew: boolean;
  /** The term the contract has reached, as recorded by a person marking it renewed. */
  minTermIndex: number;
  today: IsoDate;
  leadDays: number;
}

export type NoticeWindow =
  | { status: 'no_notice_rule' }
  | { status: 'undated'; reason: UnresolvedReason; detail: string; obligationId: string }
  | {
      /** later: the deadline is further away than the lead time. due: a decision is needed now. passed: notice can no longer be given. */
      status: 'later' | 'due' | 'passed';
      deadline: IsoDate;
      /** Negative once the deadline has passed. */
      daysLeft: number;
      decisionOpensOn: IsoDate;
      termIndex: number | null;
      termEnd: IsoDate | null;
      obligationId: string;
      trace: string[];
    };

type Dated = Extract<Schedule, { status: 'upcoming' | 'past' }>;

export function noticeWindow(notices: readonly NoticeRule[], ctx: WindowContext): NoticeWindow {
  if (notices.length === 0) return { status: 'no_notice_rule' };

  const scheduled = notices.map((n) => ({
    id: n.id,
    schedule: scheduleRule(n.rule, { terms: ctx.terms, today: ctx.today, autoRenew: ctx.autoRenew, minTermIndex: ctx.minTermIndex }),
  }));

  const pick = (status: 'upcoming' | 'past', earliest: boolean) => {
    const dated = scheduled.filter((s): s is { id: string; schedule: Dated } => s.schedule.status === status);
    dated.sort((a, b) => compareDates(a.schedule.due, b.schedule.due) * (earliest ? 1 : -1));
    return dated[0];
  };

  // The earliest upcoming deadline is the binding one; with none ahead, the most recent one that passed.
  const chosen = pick('upcoming', true) ?? pick('past', false);
  if (chosen === undefined) {
    const first = scheduled[0];
    const s = first?.schedule;
    if (first === undefined || s === undefined || s.status !== 'undated') return { status: 'no_notice_rule' };
    return { status: 'undated', reason: s.reason, detail: s.detail, obligationId: first.id };
  }

  const { due: deadline, termIndex, trace } = chosen.schedule;
  const daysLeft = diffDays(ctx.today, deadline);
  let termEnd: IsoDate | null = null;
  if (termIndex !== null) {
    const bounds = termBounds(ctx.terms, termIndex);
    if (bounds.ok) termEnd = bounds.value.end;
  }
  return {
    status: daysLeft < 0 ? 'passed' : daysLeft <= ctx.leadDays ? 'due' : 'later',
    deadline,
    daysLeft,
    decisionOpensOn: addDays(deadline, -ctx.leadDays),
    termIndex,
    termEnd,
    obligationId: chosen.id,
    trace,
  };
}

export type RolloverCheck =
  | { ok: true; next: { index: number; number: number; start: IsoDate; end: IsoDate } }
  | { ok: false; reason: TermProblem; detail: string };

/** Whether the contract can be marked renewed from `termIndex`, and the term that would start. */
export function rolloverCheck(terms: ContractTerms, termIndex: number): RolloverCheck {
  const next = termBounds(terms, termIndex + 1);
  if (!next.ok) return { ok: false, reason: next.reason, detail: next.detail };
  return { ok: true, next: { index: next.value.index, number: next.value.index + 1, start: next.value.start, end: next.value.end } };
}

export interface RolloverItem {
  id: string;
  rule: RuleTiming;
  eventDate: IsoDate | null;
}

export interface RolloverShift {
  id: string;
  before: IsoDate | null;
  after: IsoDate | null;
  changed: boolean;
}

/** Each obligation's next due date now, and after marking the contract renewed into the next term. */
export function rolloverPreview(
  items: readonly RolloverItem[],
  ctx: { terms: ContractTerms; autoRenew: boolean; termIndex: number; today: IsoDate },
): RolloverShift[] {
  const due = (item: RolloverItem, minTermIndex: number): IsoDate | null => {
    const s = scheduleRule(item.rule, { terms: ctx.terms, today: ctx.today, autoRenew: ctx.autoRenew, minTermIndex, eventDate: item.eventDate });
    return s.status === 'undated' ? null : s.due;
  };
  return items.map((item) => {
    const before = due(item, ctx.termIndex);
    const after = due(item, ctx.termIndex + 1);
    return { id: item.id, before, after, changed: before !== after };
  });
}

const DecisionInputSchema = z.strictObject({
  outcome: z.enum(DECISION_OUTCOMES),
  rationale: z.string().trim().min(10, 'say why in at least a sentence').max(4000),
});

export type DecisionInput = z.infer<typeof DecisionInputSchema>;

export function parseDecisionInput(input: unknown): { ok: true; value: DecisionInput } | { ok: false; problems: string[] } {
  const parsed = DecisionInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)) };
}
