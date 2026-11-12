import { type IsoDate, addDays, compareDates } from './dates/civil';
import { type Recurrence, type ResolveContext, type RuleTiming, type UnresolvedReason, resolveRule } from './dates/resolve';
import { type ContractTerms, type Result, type TermEndConvention, type TermProblem, termBounds } from './dates/terms';

/**
 * When an obligation is next due, given today's date. Today is always passed
 * in: core never reads the clock.
 */

export interface ScheduleContext {
  terms: ContractTerms;
  today: IsoDate;
  /** True when the contract renews on its own, so time passing moves it into the next term. */
  autoRenew: boolean;
  /** A term the contract is known to have reached, for example after a person marked it renewed. Default 0. */
  minTermIndex?: number;
  /** For rules anchored on an outside event: the date a person supplied. */
  eventDate?: IsoDate | null;
  termEndConvention?: TermEndConvention;
  /** How many dates to give for a recurring rule, counting the next one. Default 3. */
  upcomingCount?: number;
}

export type Schedule =
  | { status: 'upcoming'; due: IsoDate; later: IsoDate[]; termIndex: number | null; trace: string[] }
  /** Nothing is due from today on; `due` is the most recent date. */
  | { status: 'past'; due: IsoDate; termIndex: number | null; trace: string[] }
  | { status: 'undated'; reason: UnresolvedReason; detail: string };

/** Search no further ahead than this for a recurring rule's next date. */
const MAX_LOOKAHEAD_DAYS = 800;
const MAX_TERMS = 2000;

/** The term that today falls in. Before the contract starts, that is the first term. */
export function currentTermIndex(
  terms: ContractTerms,
  today: IsoDate,
  options: { autoRenew: boolean; minTermIndex?: number; termEndConvention?: TermEndConvention },
): Result<number, TermProblem> {
  const convention = { termEndConvention: options.termEndConvention ?? 'day_before_anniversary' } as const;
  let index = options.minTermIndex ?? 0;
  let bounds = termBounds(terms, index, convention);
  if (!bounds.ok) return bounds;
  if (!options.autoRenew) return { ok: true, value: index };

  for (let guard = 0; compareDates(bounds.value.end, today) < 0; guard += 1) {
    if (guard >= MAX_TERMS) return { ok: false, reason: 'out_of_range', detail: 'too many renewal terms to roll through' };
    const next = termBounds(terms, index + 1, convention);
    if (!next.ok) {
      if (next.reason === 'no_renewal_term') break;
      return next;
    }
    index += 1;
    bounds = next;
  }
  return { ok: true, value: index };
}

const undated = (reason: UnresolvedReason, detail: string): Schedule => ({ status: 'undated', reason, detail });

export function scheduleRule(rule: RuleTiming, ctx: ScheduleContext): Schedule {
  const base: ResolveContext = {
    terms: ctx.terms,
    termIndex: 0,
    termEndConvention: ctx.termEndConvention ?? 'day_before_anniversary',
  };
  if (ctx.eventDate !== undefined && ctx.eventDate !== null) base.eventDate = ctx.eventDate;

  // Dates that do not move with the term: one date, upcoming or past.
  if (rule.anchor === 'event' || rule.anchor === 'effective_date') {
    const r = resolveRule(rule, base);
    if (r.status !== 'resolved') return undated(r.reason, r.detail);
    const first = r.occurrences[0];
    if (first === undefined) return undated('invalid_rule', 'the rule produced no date');
    return compareDates(first.date, ctx.today) >= 0
      ? { status: 'upcoming', due: first.date, later: [], termIndex: null, trace: first.trace }
      : { status: 'past', due: first.date, termIndex: null, trace: first.trace };
  }

  const termOptions: { autoRenew: boolean; minTermIndex?: number; termEndConvention?: TermEndConvention } = { autoRenew: ctx.autoRenew };
  if (ctx.minTermIndex !== undefined) termOptions.minTermIndex = ctx.minTermIndex;
  if (base.termEndConvention !== undefined) termOptions.termEndConvention = base.termEndConvention;
  const current = currentTermIndex(ctx.terms, ctx.today, termOptions);
  if (!current.ok) return undated(current.reason, current.detail);
  const index = current.value;

  if (rule.recurrence === null) return scheduleOncePerTerm(rule, ctx, base, index);
  return scheduleRecurring(rule, rule.recurrence, ctx, base, index);
}

function scheduleOncePerTerm(rule: RuleTiming, ctx: ScheduleContext, base: ResolveContext, index: number): Schedule {
  const r = resolveRule(rule, { ...base, termIndex: index });
  if (r.status !== 'resolved') return undated(r.reason, r.detail);
  const date = r.occurrences[0];
  if (date === undefined) return undated('invalid_rule', 'the rule produced no date');
  if (compareDates(date.date, ctx.today) >= 0) {
    return { status: 'upcoming', due: date.date, later: [], termIndex: index, trace: date.trace };
  }

  // This term's deadline has passed. If the contract rolls on by itself, the next term's deadline is the one to watch.
  if (ctx.autoRenew) {
    const next = resolveRule(rule, { ...base, termIndex: index + 1 });
    const nextDate = next.status === 'resolved' ? next.occurrences[0] : undefined;
    if (nextDate !== undefined && compareDates(nextDate.date, ctx.today) >= 0) {
      return { status: 'upcoming', due: nextDate.date, later: [], termIndex: index + 1, trace: nextDate.trace };
    }
  }
  return { status: 'past', due: date.date, termIndex: index, trace: date.trace };
}

function scheduleRecurring(rule: RuleTiming, recurrence: Recurrence, ctx: ScheduleContext, base: ResolveContext, index: number): Schedule {
  const convention = { termEndConvention: base.termEndConvention ?? 'day_before_anniversary' } as const;
  const thisTerm = termBounds(ctx.terms, index, convention);
  if (!thisTerm.ok) return undated(thisTerm.reason, thisTerm.detail);
  const nextTerm = ctx.autoRenew ? termBounds(ctx.terms, index + 1, convention) : null;

  let windowEnd = nextTerm?.ok ? nextTerm.value.end : thisTerm.value.end;
  const lookahead = addDays(ctx.today, MAX_LOOKAHEAD_DAYS);
  if (compareDates(windowEnd, lookahead) > 0) windowEnd = lookahead;

  if (compareDates(ctx.today, windowEnd) <= 0) {
    const ahead = resolveRule(rule, { ...base, termIndex: index, window: { from: ctx.today, to: windowEnd } });
    if (ahead.status !== 'resolved') return undated(ahead.reason, ahead.detail);
    const [first, ...rest] = ahead.occurrences;
    if (first !== undefined) {
      const count = Math.max(1, ctx.upcomingCount ?? 3);
      const termIndex = compareDates(first.date, thisTerm.value.end) <= 0 ? index : index + 1;
      return {
        status: 'upcoming',
        due: first.date,
        later: rest.slice(0, count - 1).map((o) => o.date),
        termIndex,
        trace: first.trace,
      };
    }
  }

  // Nothing ahead in the terms the contract will run: report the last date in this term.
  const all = resolveRule(rule, { ...base, termIndex: index, window: { from: thisTerm.value.start, to: thisTerm.value.end } });
  if (all.status !== 'resolved') return undated(all.reason, all.detail);
  const last = [...all.occurrences].reverse().find((o) => compareDates(o.date, ctx.today) < 0);
  if (last === undefined) return undated('invalid_input', `no ${describeRecurrence(recurrence)} date falls inside the contract term`);
  return { status: 'past', due: last.date, termIndex: index, trace: last.trace };
}

const UNIT_WORDS: Record<string, [string, string]> = {
  day: ['day', 'days'],
  business_day: ['business day', 'business days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years'],
  quarter: ['quarter', 'quarters'],
};

const counted = (count: number, unit: string): string => {
  const [one, many] = UNIT_WORDS[unit] ?? [unit, `${unit}s`];
  return `${count} ${count === 1 ? one : many}`;
};

function describeRecurrence(recurrence: Recurrence): string {
  const { count, unit } = recurrence.every;
  if (unit === 'week') return count === 1 ? 'each week' : `every ${count} weeks`;
  const qualifier = recurrence.basis === 'calendar' ? 'calendar' : recurrence.basis === 'contract' ? 'contract' : 'fiscal';
  const [one, many] = UNIT_WORDS[unit] ?? [unit, `${unit}s`];
  return count === 1 ? `each ${qualifier} ${one}` : `every ${count} ${qualifier} ${many}`;
}

const ARTICLE = /^(the|a|an|each|every)\b/i;
const NEEDS_ARTICLE = /^(date|day|end|start|beginning|last|first|closing)\b/i;

/** Phrasing only: the model's few words for an event, made to read after "before" or "after". */
function eventPhrase(description: string | null | undefined): string {
  const text = (description ?? '').trim();
  if (text.length === 0) return 'an event the contract names';
  const article = ARTICLE.exec(text);
  if (article) return `${article[0].toLowerCase()}${text.slice(article[0].length)}`;
  return NEEDS_ARTICLE.test(text) ? `the ${text}` : text;
}

function anchorPhrase(rule: RuleTiming & { anchorDescription?: string | null }): string {
  switch (rule.anchor) {
    case 'effective_date':
      return 'the effective date';
    case 'term_start':
      return 'the start of the current term';
    case 'term_end':
      return 'the end of the current term';
    case 'period_start':
      return rule.recurrence ? `the start of ${describeRecurrence(rule.recurrence)}` : 'the start of each period';
    case 'period_end':
      return rule.recurrence ? `the end of ${describeRecurrence(rule.recurrence)}` : 'the end of each period';
    case 'anniversary':
      if (rule.recurrence && !(rule.recurrence.every.count === 1 && rule.recurrence.every.unit === 'year')) {
        return `each anniversary of the effective date, ${describeRecurrence(rule.recurrence).replace(/^each /, 'every ')}`;
      }
      return 'each anniversary of the effective date';
    case 'event':
      return eventPhrase(rule.anchorDescription);
  }
}

/** A rule's timing in plain English, for example "90 days before the end of the current term". */
export function describeTiming(rule: RuleTiming & { anchorDescription?: string | null }): string {
  const anchor = anchorPhrase(rule);
  if (rule.offset.direction === 'on') return `on ${anchor}`;
  return `${counted(rule.offset.count, rule.offset.unit)} ${rule.offset.direction} ${anchor}`;
}
