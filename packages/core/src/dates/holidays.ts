import { type BusinessCalendar, businessCalendar } from './business';
import { type IsoDate, compareDates, isValidIsoDate } from './civil';

/**
 * A contract's holiday list: the days, besides weekends, that do not count as
 * business days. A person supplies it. Covenant ships none, because a wrong
 * list would silently move deadlines. The default is weekends only, and every
 * business-day date says which list and rule produced it.
 */

export interface Holiday {
  date: IsoDate;
  /** What the day is, as the person typed it. May be empty. */
  label: string;
}

export interface HolidayList {
  name: string;
  holidays: Holiday[];
}

export const WEEKENDS_ONLY: HolidayList = { name: 'Weekends only', holidays: [] };

export const MAX_HOLIDAYS = 400;
const MAX_NAME = 80;
const MAX_LABEL = 80;
const LINE = /^(\d{4}-\d{2}-\d{2})(?:[\s,;:-]+(.*))?$/;

export type HolidayParse = { ok: true; value: HolidayList } | { ok: false; problems: string[] };

/**
 * Reads a list typed one day per line: "2026-12-25 Christmas Day". Blank lines
 * are skipped, repeats are merged, and the result is sorted. Anything that is
 * not a real date is a problem, never a guess.
 */
export function parseHolidayList(name: string, text: string): HolidayParse {
  const problems: string[] = [];
  const byDate = new Map<IsoDate, string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    const match = LINE.exec(line);
    const date = match?.[1];
    if (match === null || date === undefined || !isValidIsoDate(date)) {
      problems.push(`line ${index + 1}: start with a real date written YYYY-MM-DD`);
      return;
    }
    const label = (match[2] ?? '').trim().slice(0, MAX_LABEL);
    if (!byDate.has(date) || label !== '') byDate.set(date, label);
  });
  if (byDate.size > MAX_HOLIDAYS) problems.push(`at most ${MAX_HOLIDAYS} holidays`);
  const cleanName = name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (byDate.size > 0 && cleanName === '') problems.push('give the list a name, such as "England and Wales 2026 to 2027"');
  if (problems.length > 0) return { ok: false, problems };
  const holidays = [...byDate.entries()].map(([date, label]) => ({ date, label })).sort((a, b) => compareDates(a.date, b.date));
  return { ok: true, value: holidays.length === 0 ? WEEKENDS_ONLY : { name: cleanName, holidays } };
}

/** Checks a stored list. Anything malformed falls back to weekends only, which the screen then states. */
export function readHolidayList(stored: unknown): HolidayList {
  if (stored === null || typeof stored !== 'object') return WEEKENDS_ONLY;
  const { name, holidays } = stored as { name?: unknown; holidays?: unknown };
  if (typeof name !== 'string' || !Array.isArray(holidays)) return WEEKENDS_ONLY;
  const clean: Holiday[] = [];
  for (const h of holidays.slice(0, MAX_HOLIDAYS)) {
    const date = (h as { date?: unknown } | null)?.date;
    const label = (h as { label?: unknown } | null)?.label;
    if (isValidIsoDate(date)) clean.push({ date: date as IsoDate, label: typeof label === 'string' ? label.slice(0, MAX_LABEL) : '' });
  }
  return clean.length === 0 ? WEEKENDS_ONLY : { name: name.slice(0, MAX_NAME) || 'Holidays', holidays: clean };
}

export function calendarOf(list: HolidayList): BusinessCalendar {
  return businessCalendar({ holidays: list.holidays.map((h) => h.date) });
}

/** The rule in words, for the screen and for tools: which days count, and from which list. */
export function describeCalendar(list: HolidayList): string {
  const n = list.holidays.length;
  if (n === 0) return 'Business days are Monday to Friday. No holidays are listed for this contract, so none are skipped.';
  return `Business days are Monday to Friday, skipping the ${n} holiday${n === 1 ? '' : 's'} in "${list.name}".`;
}

/** Holidays on a weekday strictly after `from` and up to `to` (or the reverse when counting back): the days a count skipped. */
export function holidaysBetween(list: HolidayList, a: IsoDate, b: IsoDate): Holiday[] {
  const [from, to] = compareDates(a, b) <= 0 ? [a, b] : [b, a];
  return list.holidays.filter((h) => compareDates(h.date, from) >= 0 && compareDates(h.date, to) <= 0);
}

export const holidayText = (h: Holiday): string => (h.label ? `${h.date} (${h.label})` : h.date);
