import { type IsoDate, addDays, addMonths, diffDays, isValidIsoDate } from './civil';

export type DurationUnit = 'day' | 'business_day' | 'week' | 'month' | 'year';

export interface Duration {
  count: number;
  unit: DurationUnit;
}

/**
 * The facts every term date hangs from. Each is either read from the contract
 * (and verified against its quote elsewhere) or entered by a person. `null`
 * means "not known", and the engine refuses rather than assume.
 */
export interface ContractTerms {
  effectiveDate: IsoDate | null;
  /** Length of the initial term, when the contract gives a length. */
  initialTerm: Duration | null;
  /** Last day of the initial term, when the contract states the date outright. Wins over a computed end. */
  initialTermEnd: IsoDate | null;
  /** Length of each renewal term. `null` means the contract does not renew. */
  renewalTerm: Duration | null;
}

export type TermFact = 'effectiveDate' | 'initialTerm' | 'initialTermEnd' | 'renewalTerm';

/**
 * How to read "a one-year term starting 1 January 2024":
 * - `day_before_anniversary`: the last day is 31 December 2024. This is the default
 *   because it puts every "N days before the end of the term" deadline one day
 *   earlier, and an early deadline is the safe mistake.
 * - `anniversary`: the term ends on 1 January 2025.
 */
export type TermEndConvention = 'day_before_anniversary' | 'anniversary';

export type TermProblem =
  | 'missing_effective_date'
  | 'missing_initial_term'
  | 'no_renewal_term'
  | 'unsupported_term_unit'
  | 'invalid_term_facts'
  | 'conflicting_term_facts'
  | 'invalid_term_index'
  | 'out_of_range';

export type Result<T, R extends string> = { ok: true; value: T } | { ok: false; reason: R; detail: string };

export interface TermBounds {
  /** 0 is the initial term, 1 the first renewal, and so on. */
  index: number;
  start: IsoDate;
  end: IsoDate;
  /** The facts this answer was computed from. Change one and this answer changes. */
  dependsOn: TermFact[];
  trace: string[];
}

export interface TermOptions {
  termEndConvention?: TermEndConvention;
}

const fail = <R extends string>(reason: R, detail: string): { ok: false; reason: R; detail: string } => ({
  ok: false,
  reason,
  detail,
});

const isMonthBased = (d: Duration): boolean => d.unit === 'month' || d.unit === 'year';
const inMonths = (d: Duration): number => (d.unit === 'year' ? d.count * 12 : d.count);

const describeDuration = (d: Duration): string => `${d.count} ${d.unit.replace('_', ' ')}${d.count === 1 ? '' : 's'}`;

function checkDuration(d: Duration, name: string): { ok: true } | { ok: false; reason: TermProblem; detail: string } {
  if (d.unit === 'business_day') return fail('unsupported_term_unit', `${name} is measured in business days`);
  if (!['day', 'week', 'month', 'year'].includes(d.unit)) return fail('invalid_term_facts', `${name} has an unknown unit`);
  if (!Number.isInteger(d.count) || d.count < 1) return fail('invalid_term_facts', `${name} must be a whole number of at least 1`);
  return { ok: true };
}

/** `date` plus `times` copies of `duration`, measured from `date` in one step so month ends do not drift. */
function addDuration(date: IsoDate, duration: Duration, times: number): IsoDate {
  switch (duration.unit) {
    case 'day':
      return addDays(date, duration.count * times);
    case 'week':
      return addDays(date, duration.count * 7 * times);
    case 'month':
    case 'year':
      return addMonths(date, inMonths(duration) * times);
    case 'business_day':
      throw new TypeError('terms cannot be measured in business days');
  }
}

/**
 * First and last day of a term. Term 0 is the initial term; each later index is
 * one renewal further on. Returns a reason instead of a date whenever a fact is
 * missing, invalid or contradicted.
 */
export function termBounds(terms: ContractTerms, termIndex: number, options: TermOptions = {}): Result<TermBounds, TermProblem> {
  const convention: TermEndConvention = options.termEndConvention ?? 'day_before_anniversary';

  if (!Number.isInteger(termIndex) || termIndex < 0) {
    return fail('invalid_term_index', 'term index must be a whole number, 0 or more');
  }
  const { effectiveDate, initialTerm, initialTermEnd, renewalTerm } = terms;
  if (effectiveDate === null) return fail('missing_effective_date', 'the effective date is not known');
  if (!isValidIsoDate(effectiveDate)) return fail('invalid_term_facts', 'the effective date is not a valid date');

  if (initialTerm !== null) {
    const check = checkDuration(initialTerm, 'the initial term');
    if (!check.ok) return check;
  }
  if (initialTermEnd !== null) {
    if (!isValidIsoDate(initialTermEnd)) return fail('invalid_term_facts', 'the stated end date is not a valid date');
    if (diffDays(effectiveDate, initialTermEnd) <= 0) {
      return fail('invalid_term_facts', 'the stated end date is not after the effective date');
    }
  }

  try {
    const trace: string[] = [];
    const dependsOn: TermFact[] = ['effectiveDate'];

    // firstRenewalStart is the day the first renewal term would begin.
    let initialEnd: IsoDate;
    let firstRenewalStart: IsoDate;
    const usesStatedEnd = initialTermEnd !== null;

    if (initialTermEnd !== null) {
      if (initialTerm !== null) {
        const computedEnd = addDays(addDuration(effectiveDate, initialTerm, 1), -1);
        if (Math.abs(diffDays(computedEnd, initialTermEnd)) > 1) {
          return fail(
            'conflicting_term_facts',
            `the stated end date ${initialTermEnd} disagrees with ${describeDuration(initialTerm)} from ${effectiveDate} (${computedEnd})`,
          );
        }
      }
      initialEnd = initialTermEnd;
      firstRenewalStart = addDays(initialTermEnd, 1);
      dependsOn.push('initialTermEnd');
      trace.push(`initial term: ${effectiveDate} to ${initialTermEnd} (end date stated in the contract)`);
    } else if (initialTerm !== null) {
      firstRenewalStart = addDuration(effectiveDate, initialTerm, 1);
      initialEnd = convention === 'anniversary' ? firstRenewalStart : addDays(firstRenewalStart, -1);
      dependsOn.push('initialTerm');
      trace.push(`initial term: ${effectiveDate} + ${describeDuration(initialTerm)} = ${initialEnd} (${describeConvention(convention)})`);
    } else {
      return fail('missing_initial_term', 'neither a term length nor an end date is known');
    }

    if (termIndex === 0) {
      return { ok: true, value: { index: 0, start: effectiveDate, end: initialEnd, dependsOn, trace } };
    }

    if (renewalTerm === null) return fail('no_renewal_term', 'the contract has no renewal term');
    const check = checkDuration(renewalTerm, 'the renewal term');
    if (!check.ok) return check;
    dependsOn.push('renewalTerm');

    // Start of renewal number n (n = 1 is the first renewal). Always measured from a
    // fixed base in one step: adding a month at a time would drift at month ends.
    const measureFromEffectiveDate = !usesStatedEnd && initialTerm !== null && isMonthBased(initialTerm) && isMonthBased(renewalTerm);
    const renewalStart = (n: number): IsoDate =>
      measureFromEffectiveDate && initialTerm !== null
        ? addMonths(effectiveDate, inMonths(initialTerm) + inMonths(renewalTerm) * (n - 1))
        : addDuration(firstRenewalStart, renewalTerm, n - 1);

    const start = renewalStart(termIndex);
    const nextStart = renewalStart(termIndex + 1);
    const end = convention === 'anniversary' ? nextStart : addDays(nextStart, -1);
    trace.push(`renewal ${termIndex}: ${start} + ${describeDuration(renewalTerm)} = ${end} (${describeConvention(convention)})`);
    return { ok: true, value: { index: termIndex, start, end, dependsOn, trace } };
  } catch (error) {
    if (error instanceof RangeError) return fail('out_of_range', 'the term runs outside the supported years');
    throw error;
  }
}

export function describeConvention(convention: TermEndConvention): string {
  return convention === 'anniversary'
    ? 'term ends on the anniversary'
    : 'term ends the day before the anniversary';
}
