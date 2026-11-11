import { type IsoDate, addDays, dayOfWeek, fromDayNumber, isValidIsoDate, toDayNumber } from './civil';

/**
 * Which days count as business days. Weekend days are 0 (Sunday) to 6
 * (Saturday). Holidays are supplied by the caller: this package ships no
 * holiday list, because a wrong one would silently move deadlines.
 */
export interface BusinessCalendar {
  readonly weekend: ReadonlySet<number>;
  readonly holidays: ReadonlySet<IsoDate>;
}

export function businessCalendar(options: { weekend?: readonly number[]; holidays?: readonly IsoDate[] } = {}): BusinessCalendar {
  const weekend = new Set(options.weekend ?? [0, 6]);
  for (const day of weekend) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError(`weekend day must be 0 (Sunday) to 6 (Saturday), got ${day}`);
    }
  }
  if (weekend.size >= 7) throw new RangeError('a calendar needs at least one working day in the week');

  const holidays = new Set<IsoDate>();
  for (const holiday of options.holidays ?? []) {
    if (!isValidIsoDate(holiday)) throw new TypeError(`holiday is not a valid ISO date: ${String(holiday)}`);
    holidays.add(holiday);
  }
  return { weekend, holidays };
}

/** Monday to Friday, no holidays. */
export const WEEKDAYS: BusinessCalendar = businessCalendar();

export function isBusinessDay(date: IsoDate, calendar: BusinessCalendar): boolean {
  return !calendar.weekend.has(dayOfWeek(date)) && !calendar.holidays.has(date);
}

/**
 * Step `count` business days from `date`. Counting starts the day after (or
 * before) `date`, so the start day itself is never counted, whether or not it
 * is a business day. Zero returns `date` unchanged.
 */
export function addBusinessDays(date: IsoDate, count: number, calendar: BusinessCalendar): IsoDate {
  if (!Number.isInteger(count)) throw new TypeError(`count must be a whole number, got ${count}`);
  toDayNumber(date); // validates
  if (count === 0) return date;

  const step = count > 0 ? 1 : -1;
  let remaining = Math.abs(count);
  let current = date;
  // Each working day is at most 6 weekend days plus the holidays away from the next.
  let budget = remaining * 7 + calendar.holidays.size + 14;
  while (remaining > 0) {
    if (budget-- <= 0) throw new RangeError('business-day search did not finish; check the calendar');
    current = addDays(current, step);
    if (isBusinessDay(current, calendar)) remaining -= 1;
  }
  return current;
}

/** Business days after `from`, up to and including `to`. Zero when `to` is not later. */
export function countBusinessDays(from: IsoDate, to: IsoDate, calendar: BusinessCalendar): number {
  const end = toDayNumber(to);
  let count = 0;
  for (let day = toDayNumber(from) + 1; day <= end; day += 1) {
    if (isBusinessDay(fromDayNumber(day), calendar)) count += 1;
  }
  return count;
}

export type RollDirection = 'preceding' | 'following';

/** Move a non-business day to the nearest business day in the given direction. Business days are returned unchanged. */
export function rollToBusinessDay(date: IsoDate, direction: RollDirection, calendar: BusinessCalendar): IsoDate {
  if (isBusinessDay(date, calendar)) return date;
  return addBusinessDays(date, direction === 'following' ? 1 : -1, calendar);
}
