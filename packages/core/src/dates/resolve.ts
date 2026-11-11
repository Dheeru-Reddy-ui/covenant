import {
  type BusinessCalendar,
  type RollDirection,
  WEEKDAYS,
  addBusinessDays,
  isBusinessDay,
  rollToBusinessDay,
} from './business';
import {
  type IsoDate,
  MAX_YEAR,
  MIN_YEAR,
  addDays,
  addMonths,
  endOfMonth,
  fromDayNumber,
  isValidIsoDate,
  toDayNumber,
  yearMonth,
} from './civil';
import {
  type ContractTerms,
  type DurationUnit,
  type TermEndConvention,
  type TermFact,
  type TermProblem,
  describeConvention,
  termBounds,
} from './terms';

/**
 * What a deadline is measured from.
 * - effective_date, term_start, term_end: one date per term, from the contract's term facts.
 * - period_start, period_end: one date per recurring period (needs a recurrence).
 * - anniversary: each anniversary of the effective date, not the effective date itself (needs a recurrence).
 * - event: something outside the contract's own calendar, such as receipt of an invoice.
 *   The engine refuses until a person supplies the date.
 */
export type AnchorEvent =
  | 'effective_date'
  | 'term_start'
  | 'term_end'
  | 'period_start'
  | 'period_end'
  | 'anniversary'
  | 'event';

export type OffsetDirection = 'before' | 'after' | 'on';

export interface Offset {
  count: number;
  unit: DurationUnit;
  direction: OffsetDirection;
}

export type RecurrenceUnit = 'week' | 'month' | 'quarter' | 'year';

/**
 * Which periods a recurring rule counts in.
 * - calendar: calendar months, quarters and years.
 * - contract: periods measured from the effective date ("each contract year").
 * - fiscal: a party's fiscal year. Refused until the fiscal year start month is supplied.
 */
export type RecurrenceBasis = 'calendar' | 'contract' | 'fiscal';

export interface Recurrence {
  every: { count: number; unit: RecurrenceUnit };
  basis: RecurrenceBasis;
}

/** The timing part of an obligation rule: everything the date engine needs and nothing else. */
export interface RuleTiming {
  anchor: AnchorEvent;
  offset: Offset;
  recurrence: Recurrence | null;
}

export interface ResolveContext {
  terms: ContractTerms;
  /** Which term to resolve for. 0 is the initial term. Marking a contract renewed means adding one. */
  termIndex: number;
  /** Defaults to Monday to Friday with no holidays. */
  calendar?: BusinessCalendar;
  termEndConvention?: TermEndConvention;
  /** Move a date that lands on a non-business day. Default 'none': the date is left alone and flagged. */
  roll?: 'none' | RollDirection;
  /** The date of the outside event, for rules anchored on 'event'. */
  eventDate?: IsoDate;
  /** For recurring rules: only dates inside this window are returned. Defaults to the current term. */
  window?: { from: IsoDate; to: IsoDate };
  /** 1 to 12. Needed only for rules on a fiscal basis. */
  fiscalYearStartMonth?: number;
  /** Refuse rather than return more dates than this. Default 500. */
  maxOccurrences?: number;
}

export interface Occurrence {
  date: IsoDate;
  /** The date the offset was applied to. */
  anchorDate: IsoDate;
  onBusinessDay: boolean;
  /** Present when `roll` moved the date: the date before rolling. */
  rolledFrom?: IsoDate;
  periodStart?: IsoDate;
  periodEnd?: IsoDate;
  /** Plain-language steps from facts to date. Contains dates and durations only, never contract text. */
  trace: string[];
}

export type UnresolvedReason =
  | TermProblem
  | 'needs_event_date'
  | 'needs_fiscal_year'
  | 'invalid_rule'
  | 'invalid_input'
  | 'unsupported_recurrence'
  | 'too_many_occurrences';

export interface AppliedConventions {
  termEnd: TermEndConvention;
  /** A month offset that lands past the end of a shorter month clamps to its last day. */
  monthArithmetic: 'clamp_to_month_end';
  /** Business days are counted starting the day after (or before) the anchor. */
  businessDays: 'count_from_next_day';
  roll: 'none' | RollDirection;
}

export type Resolution =
  | { status: 'resolved'; occurrences: Occurrence[]; dependsOn: TermFact[]; conventions: AppliedConventions }
  | { status: 'unresolved'; reason: UnresolvedReason; detail: string };

const MAX_OFFSET_COUNT = 10_000;
const DEFAULT_MAX_OCCURRENCES = 500;
const CALENDAR_STEPS_IN_MONTHS = new Set([1, 2, 3, 4, 6, 12]);

const unresolved = (reason: UnresolvedReason, detail: string): Resolution => ({ status: 'unresolved', reason, detail });

const plural = (count: number, unit: string): string => `${count} ${unit.replace('_', ' ')}${count === 1 ? '' : 's'}`;

function checkRule(rule: RuleTiming): string | null {
  const { offset, recurrence, anchor } = rule;
  if (!Number.isInteger(offset.count) || offset.count < 0 || offset.count > MAX_OFFSET_COUNT) {
    return `offset count must be a whole number from 0 to ${MAX_OFFSET_COUNT}`;
  }
  if (!['day', 'business_day', 'week', 'month', 'year'].includes(offset.unit)) return 'offset has an unknown unit';
  if (!['before', 'after', 'on'].includes(offset.direction)) return 'offset has an unknown direction';
  if (offset.direction === 'on' && offset.count !== 0) return '"on" cannot carry a count';
  if (offset.direction !== 'on' && offset.count === 0) return '"before" and "after" need a count of at least 1';

  const recurring = anchor === 'period_start' || anchor === 'period_end' || anchor === 'anniversary';
  if (recurring && recurrence === null) return `anchor ${anchor} needs a recurrence`;
  if (!recurring && recurrence !== null) return `anchor ${anchor} cannot recur`;
  if (recurrence !== null) {
    if (!Number.isInteger(recurrence.every.count) || recurrence.every.count < 1) {
      return 'recurrence count must be a whole number of at least 1';
    }
    if (!['week', 'month', 'quarter', 'year'].includes(recurrence.every.unit)) return 'recurrence has an unknown unit';
    if (!['calendar', 'contract', 'fiscal'].includes(recurrence.basis)) return 'recurrence has an unknown basis';
    if (anchor === 'anniversary' && recurrence.basis !== 'contract') {
      return 'anniversaries are measured from the effective date, so the basis must be "contract"';
    }
  }
  return null;
}

function applyOffset(anchorDate: IsoDate, offset: Offset, calendar: BusinessCalendar): IsoDate {
  if (offset.direction === 'on') return anchorDate;
  const signed = offset.direction === 'before' ? -offset.count : offset.count;
  switch (offset.unit) {
    case 'day':
      return addDays(anchorDate, signed);
    case 'week':
      return addDays(anchorDate, signed * 7);
    case 'month':
      return addMonths(anchorDate, signed);
    case 'year':
      return addMonths(anchorDate, signed * 12);
    case 'business_day':
      return addBusinessDays(anchorDate, signed, calendar);
  }
}

/** An upper bound, in days, on how far an offset can move a date. Used to widen the search window. */
function offsetReachInDays(offset: Offset, calendar: BusinessCalendar): number {
  switch (offset.unit) {
    case 'day':
      return offset.count;
    case 'week':
      return offset.count * 7;
    case 'month':
      return offset.count * 31;
    case 'year':
      return offset.count * 366;
    case 'business_day':
      return offset.count * 7 + calendar.holidays.size + 14;
  }
}

interface Anchor {
  date: IsoDate;
  label: string;
  periodStart?: IsoDate;
  periodEnd?: IsoDate;
}

function describeOffset(offset: Offset): string {
  return offset.direction === 'on' ? 'on that date' : `${plural(offset.count, offset.unit)} ${offset.direction}`;
}

function makeOccurrence(anchor: Anchor, rule: RuleTiming, ctx: ResolveContext, calendar: BusinessCalendar, lead: string[]): Occurrence {
  const raw = applyOffset(anchor.date, rule.offset, calendar);
  const roll = ctx.roll ?? 'none';
  const date = roll === 'none' ? raw : rollToBusinessDay(raw, roll, calendar);
  const trace = [...lead, `${anchor.label}: ${anchor.date}`, `${describeOffset(rule.offset)}: ${raw}`];
  if (date !== raw) trace.push(`moved to the ${roll} business day: ${date}`);

  const occurrence: Occurrence = { date, anchorDate: anchor.date, onBusinessDay: isBusinessDay(date, calendar), trace };
  if (date !== raw) occurrence.rolledFrom = raw;
  if (anchor.periodStart !== undefined) occurrence.periodStart = anchor.periodStart;
  if (anchor.periodEnd !== undefined) occurrence.periodEnd = anchor.periodEnd;
  return occurrence;
}

/** First day of the month numbered `absoluteMonth` (year * 12 + zero-based month). */
function firstOfAbsoluteMonth(absoluteMonth: number): IsoDate {
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12 + 1;
  if (year < MIN_YEAR || year > MAX_YEAR) throw new RangeError('date is outside the supported years');
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

const MIN_DAY = toDayNumber(`${MIN_YEAR}-01-01`);
const MAX_DAY = toDayNumber(`${MAX_YEAR}-12-31`);

/** year * 12 + zero-based month of the day numbered `day`, clamped to the supported years. */
function absoluteMonthOfDay(day: number): number {
  const { year, month } = yearMonth(fromDayNumber(Math.min(MAX_DAY, Math.max(MIN_DAY, day))));
  return year * 12 + (month - 1);
}

interface PeriodPlan {
  /** Anchor for period number `index`, or null when that period creates no obligation. */
  anchorAt: (index: number) => Anchor | null;
  /** The first period index worth looking at for a search starting on `fromDay`. */
  firstIndex: (fromDay: number) => number;
  /** Lowest index that exists at all. */
  minIndex: number;
}

function planPeriods(rule: RuleTiming, recurrence: Recurrence, ctx: ResolveContext): PeriodPlan | Resolution {
  const { every, basis } = recurrence;
  const monthsPerUnit = every.unit === 'month' ? 1 : every.unit === 'quarter' ? 3 : every.unit === 'year' ? 12 : 0;
  const stepMonths = monthsPerUnit * every.count;
  const pick = (start: IsoDate, end: IsoDate, label: string): Anchor => ({
    date: rule.anchor === 'period_end' ? end : start,
    label: `${rule.anchor === 'period_end' ? 'end' : 'start'} of ${label}`,
    periodStart: start,
    periodEnd: end,
  });

  if (basis === 'contract') {
    const effective = ctx.terms.effectiveDate;
    if (effective === null) return unresolved('missing_effective_date', 'contract periods are measured from the effective date, which is not known');
    if (!isValidIsoDate(effective)) return unresolved('invalid_term_facts', 'the effective date is not a valid date');
    const effectiveDay = toDayNumber(effective);
    const stepDays = every.unit === 'week' ? every.count * 7 : 0;
    const boundary = (k: number): IsoDate => (stepDays > 0 ? addDays(effective, k * stepDays) : addMonths(effective, k * stepMonths));
    const approxStepDays = stepDays > 0 ? stepDays : stepMonths * 31;

    if (rule.anchor === 'anniversary') {
      return {
        minIndex: 1,
        firstIndex: (fromDay) => Math.floor((fromDay - effectiveDay) / approxStepDays) - 1,
        anchorAt: (k) => ({ date: boundary(k), label: `anniversary ${k} of the effective date` }),
      };
    }
    return {
      minIndex: 0,
      firstIndex: (fromDay) => Math.floor((fromDay - effectiveDay) / approxStepDays) - 1,
      anchorAt: (k) => pick(boundary(k), addDays(boundary(k + 1), -1), `contract period ${k + 1}`),
    };
  }

  // Calendar and fiscal periods are whole months aligned to the start of the (fiscal) year.
  if (every.unit === 'week') return unresolved('unsupported_recurrence', `weekly periods on a ${basis} basis have no agreed start day`);
  if (!CALENDAR_STEPS_IN_MONTHS.has(stepMonths)) {
    return unresolved('unsupported_recurrence', `a period of ${stepMonths} months does not divide a year, so its start is ambiguous`);
  }

  let shift = 0;
  if (basis === 'fiscal') {
    const startMonth = ctx.fiscalYearStartMonth;
    if (startMonth === undefined) return unresolved('needs_fiscal_year', 'the fiscal year start month is not known');
    if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
      return unresolved('invalid_input', 'fiscal year start month must be 1 to 12');
    }
    shift = startMonth - 1;
  }

  const effective = ctx.terms.effectiveDate;
  const label = basis === 'fiscal' ? 'fiscal period' : 'calendar period';
  return {
    minIndex: Number.NEGATIVE_INFINITY,
    firstIndex: (fromDay) => Math.floor((absoluteMonthOfDay(fromDay) - shift) / stepMonths) - 1,
    anchorAt: (p) => {
      const start = firstOfAbsoluteMonth(p * stepMonths + shift);
      const end = endOfMonth(firstOfAbsoluteMonth((p + 1) * stepMonths + shift - 1));
      const anchor = pick(start, end, `${label} ${start} to ${end}`);
      // A period whose anchor falls before the contract took effect creates no obligation.
      if (effective !== null && isValidIsoDate(effective) && toDayNumber(anchor.date) < toDayNumber(effective)) {
        return null;
      }
      return anchor;
    },
  };
}

function isResolution(value: PeriodPlan | Resolution): value is Resolution {
  return 'status' in value;
}

/**
 * Turn a rule's timing into calendar dates. Deterministic: the same rule and
 * context always give the same answer, and the function never reads the clock.
 * When anything needed is missing, contradictory or unsupported it returns
 * `unresolved` with a reason. It never guesses.
 */
export function resolveRule(rule: RuleTiming, ctx: ResolveContext): Resolution {
  const problem = checkRule(rule);
  if (problem !== null) return unresolved('invalid_rule', problem);

  const calendar = ctx.calendar ?? WEEKDAYS;
  const termEnd: TermEndConvention = ctx.termEndConvention ?? 'day_before_anniversary';
  const conventions: AppliedConventions = {
    termEnd,
    monthArithmetic: 'clamp_to_month_end',
    businessDays: 'count_from_next_day',
    roll: ctx.roll ?? 'none',
  };

  try {
    if (rule.recurrence === null) {
      return resolveOnce(rule, ctx, calendar, conventions);
    }
    return resolveRecurring(rule, rule.recurrence, ctx, calendar, conventions);
  } catch (error) {
    if (error instanceof RangeError) return unresolved('out_of_range', 'a date falls outside the supported years');
    throw error;
  }
}

function resolveOnce(rule: RuleTiming, ctx: ResolveContext, calendar: BusinessCalendar, conventions: AppliedConventions): Resolution {
  const { terms } = ctx;
  let anchor: Anchor;
  let dependsOn: TermFact[] = [];
  let lead: string[] = [];

  switch (rule.anchor) {
    case 'effective_date': {
      if (terms.effectiveDate === null) return unresolved('missing_effective_date', 'the effective date is not known');
      if (!isValidIsoDate(terms.effectiveDate)) return unresolved('invalid_term_facts', 'the effective date is not a valid date');
      anchor = { date: terms.effectiveDate, label: 'effective date' };
      dependsOn = ['effectiveDate'];
      break;
    }
    case 'term_start':
    case 'term_end': {
      const bounds = termBounds(terms, ctx.termIndex, { termEndConvention: conventions.termEnd });
      if (!bounds.ok) return unresolved(bounds.reason, bounds.detail);
      const isEnd = rule.anchor === 'term_end';
      anchor = {
        date: isEnd ? bounds.value.end : bounds.value.start,
        label: `${isEnd ? 'end' : 'start'} of term ${bounds.value.index + 1}`,
      };
      dependsOn = bounds.value.dependsOn;
      lead = [...bounds.value.trace];
      if (isEnd) lead.push(`convention: ${describeConvention(conventions.termEnd)}`);
      break;
    }
    case 'event': {
      if (ctx.eventDate === undefined) return unresolved('needs_event_date', 'this deadline runs from an event whose date a person must supply');
      if (!isValidIsoDate(ctx.eventDate)) return unresolved('invalid_input', 'the supplied event date is not a valid date');
      anchor = { date: ctx.eventDate, label: 'event date (supplied by a person)' };
      break;
    }
    default:
      return unresolved('invalid_rule', `anchor ${rule.anchor} needs a recurrence`);
  }

  return { status: 'resolved', occurrences: [makeOccurrence(anchor, rule, ctx, calendar, lead)], dependsOn, conventions };
}

function resolveRecurring(
  rule: RuleTiming,
  recurrence: Recurrence,
  ctx: ResolveContext,
  calendar: BusinessCalendar,
  conventions: AppliedConventions,
): Resolution {
  const dependsOn = new Set<TermFact>();

  let window = ctx.window;
  if (window === undefined) {
    const bounds = termBounds(ctx.terms, ctx.termIndex, { termEndConvention: conventions.termEnd });
    if (!bounds.ok) return unresolved(bounds.reason, bounds.detail);
    window = { from: bounds.value.start, to: bounds.value.end };
    for (const fact of bounds.value.dependsOn) dependsOn.add(fact);
  }
  if (!isValidIsoDate(window.from) || !isValidIsoDate(window.to)) return unresolved('invalid_input', 'the window has an invalid date');
  const fromDay = toDayNumber(window.from);
  const toDay = toDayNumber(window.to);
  if (fromDay > toDay) return unresolved('invalid_input', 'the window ends before it starts');

  const plan = planPeriods(rule, recurrence, ctx);
  if (isResolution(plan)) return plan;
  if (recurrence.basis === 'contract' || ctx.terms.effectiveDate !== null) dependsOn.add('effectiveDate');

  const maxOccurrences = ctx.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const reach = offsetReachInDays(rule.offset, calendar) + 7;
  const searchFrom = fromDay - reach;
  const searchTo = toDay + reach;

  const occurrences: Occurrence[] = [];
  const seen = new Set<IsoDate>();
  let index = Math.max(plan.minIndex, plan.firstIndex(searchFrom));
  // Bounded by the window: every period advances the anchor by at least a week.
  for (let guard = 0; guard < 200_000; guard += 1, index += 1) {
    const anchor = plan.anchorAt(index);
    if (anchor === null) continue;
    const anchorDay = toDayNumber(anchor.date);
    if (anchorDay > searchTo) break;
    if (anchorDay < searchFrom) continue;

    const occurrence = makeOccurrence(anchor, rule, ctx, calendar, []);
    const day = toDayNumber(occurrence.date);
    if (day < fromDay || day > toDay || seen.has(occurrence.date)) continue;
    seen.add(occurrence.date);
    occurrences.push(occurrence);
    if (occurrences.length > maxOccurrences) {
      return unresolved('too_many_occurrences', `more than ${maxOccurrences} dates fall in the window; narrow it`);
    }
  }

  occurrences.sort((a, b) => toDayNumber(a.date) - toDayNumber(b.date));
  return { status: 'resolved', occurrences, dependsOn: [...dependsOn], conventions };
}
