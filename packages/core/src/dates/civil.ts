/**
 * Civil (calendar) date arithmetic on ISO strings, 'YYYY-MM-DD'.
 *
 * A contract deadline is a calendar day, not an instant, so this module has no
 * times, no time zones and never touches the JS Date object or the clock.
 * Every function is total over valid input and throws on invalid input: a
 * caller that passes a bad date has a bug, and a thrown error is safer than a
 * quietly wrong deadline.
 */

export type IsoDate = string;

export const MIN_YEAR = 1800;
export const MAX_YEAR = 2300;

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`month out of range: ${month}`);
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function parse(value: unknown): Ymd | null {
  if (typeof value !== 'string') return null;
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function mustParse(value: unknown): Ymd {
  const ymd = parse(value);
  if (!ymd) throw new TypeError(`not a valid ISO date (YYYY-MM-DD, ${MIN_YEAR}-${MAX_YEAR}): ${String(value)}`);
  return ymd;
}

function format({ y, m, d }: Ymd): IsoDate {
  if (y < MIN_YEAR || y > MAX_YEAR) {
    throw new RangeError(`date is outside the supported years ${MIN_YEAR}-${MAX_YEAR}`);
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** True only for a real calendar day written as YYYY-MM-DD inside the supported years. */
export function isValidIsoDate(value: unknown): value is IsoDate {
  return parse(value) !== null;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's algorithm).
function daysFromCivil({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(dayNumber: number): Ymd {
  const z = dayNumber + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}

function mustBeInteger(n: number, name: string): void {
  if (!Number.isInteger(n)) throw new TypeError(`${name} must be a whole number, got ${n}`);
}

/** Days since 1970-01-01. Negative before it. */
export function toDayNumber(date: IsoDate): number {
  return daysFromCivil(mustParse(date));
}

export function fromDayNumber(dayNumber: number): IsoDate {
  mustBeInteger(dayNumber, 'dayNumber');
  return format(civilFromDays(dayNumber));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  mustBeInteger(days, 'days');
  return fromDayNumber(toDayNumber(date) + days);
}

/** Whole days from `from` to `to`. Positive when `to` is later. */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  // 1970-01-01 was a Thursday.
  return (((toDayNumber(date) + 4) % 7) + 7) % 7;
}

/**
 * Add calendar months. When the target month is shorter, the day clamps to its
 * last day (31 January + 1 month = 28 or 29 February). It never spills into
 * the following month.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  mustBeInteger(months, 'months');
  const { y, m, d } = mustParse(date);
  const absolute = y * 12 + (m - 1) + months;
  const year = Math.floor(absolute / 12);
  const month = absolute - year * 12 + 1;
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(`date is outside the supported years ${MIN_YEAR}-${MAX_YEAR}`);
  }
  return format({ y: year, m: month, d: Math.min(d, daysInMonth(year, month)) });
}

export function addYears(date: IsoDate, years: number): IsoDate {
  mustBeInteger(years, 'years');
  return addMonths(date, years * 12);
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { y, m } = mustParse(date);
  return format({ y, m, d: 1 });
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { y, m } = mustParse(date);
  return format({ y, m, d: daysInMonth(y, m) });
}

/** Negative when a is earlier, positive when later, zero when equal. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/** Year and 1-based month of a date. */
export function yearMonth(date: IsoDate): { year: number; month: number } {
  const { y, m } = mustParse(date);
  return { year: y, month: m };
}
