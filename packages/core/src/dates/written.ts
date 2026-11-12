import { type IsoDate, MAX_YEAR, MIN_YEAR, isValidIsoDate } from './civil';

/**
 * Reads one date as a contract writes it ("March 1, 2025", "the 1st day of
 * March, 2025", "2025-03-01") into an ISO date.
 *
 * The model may copy a date's text out of the contract; it never states a date
 * itself. This is the code that turns that text into a date, and it refuses
 * whenever the text leaves any doubt: blanks, two-digit years, or a numeric
 * form like 03/04/2025 whose day and month order is not known.
 */

export type NumericOrder = 'month_first' | 'day_first';

export interface WrittenDateOptions {
  /**
   * How to read numeric dates where both numbers could be the month. Unset
   * means refuse them. A site can set this once for its contracts.
   */
  numericOrder?: NumericOrder;
}

export type WrittenDateProblem =
  /** The text has blanks or lacks a day, as in "____, 2020" or "March 2020". */
  | 'incomplete'
  /** A numeric date like 3/4/2025 that reads differently month-first and day-first. */
  | 'ambiguous_order'
  /** A two-digit year: the century would be a guess. */
  | 'two_digit_year'
  /** Every part is present but the date does not exist, like 30 February. */
  | 'invalid_date'
  /** Not one recognisable written date. */
  | 'unrecognised';

export type WrittenDate = { ok: true; date: IsoDate } | { ok: false; reason: WrittenDateProblem };

const MONTHS: ReadonlyMap<string, number> = new Map(
  [
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may', 'may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
  ].flatMap((names, index) => names.map((name) => [name, index + 1] as const)),
);

const UNITS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
const TEENS = ['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];

/** "first" to "thirty-first", written with a hyphen or a space. */
const ORDINAL_WORDS: ReadonlyMap<string, number> = (() => {
  const words = new Map<string, number>();
  UNITS.forEach((word, i) => words.set(word, i + 1));
  TEENS.forEach((word, i) => words.set(word, i + 10));
  words.set('twentieth', 20);
  words.set('thirtieth', 30);
  UNITS.forEach((word, i) => {
    words.set(`twenty-${word}`, 21 + i);
    words.set(`twenty ${word}`, 21 + i);
  });
  words.set('thirty-first', 31);
  words.set('thirty first', 31);
  return words;
})();

const MONTH = '([a-z]+)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = "(?:a\\.?d\\.?\\s+)?('?\\d{2,4})";
const LEAD = '(?:(?:on|as of|dated)\\s+)?(?:(?:the|this)\\s+)?';

/** Anchored patterns over the lower-cased, single-spaced text. Each names where its parts sit. */
const WORD_FORMS: ReadonlyArray<{ re: RegExp; month: number; day: number; year: number }> = [
  // March 1, 2025 / Mar. 1st 2025
  { re: new RegExp(`^${LEAD}${MONTH}\\s+${DAY},?\\s+${YEAR}$`), month: 1, day: 2, year: 3 },
  // 1 March 2025 / 1st March, 2025
  { re: new RegExp(`^${LEAD}${DAY}\\s+${MONTH},?\\s+${YEAR}$`), month: 2, day: 1, year: 3 },
  // the 1st day of March, 2025
  { re: new RegExp(`^${LEAD}${DAY}\\s+day\\s+of\\s+${MONTH},?\\s+${YEAR}$`), month: 2, day: 1, year: 3 },
];

const ORDINAL_DAY_FORM = new RegExp(`^${LEAD}([a-z]+(?:[- ][a-z]+)?)\\s+day\\s+of\\s+${MONTH},?\\s+${YEAR}$`);
const ISO_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC_FORM = /^(\d{1,2})([/.-])(\d{1,2})\2('?\d{2,4})$/;

const BLANK = /_{2,}|\[\s*\]|\(\s*\)|\*{2,}|\bxx\b/;

function finish(year: string, month: number, day: number): WrittenDate {
  const digits = year.replace(/^'/, '');
  if (digits.length !== 4) return { ok: false, reason: 'two_digit_year' };
  const y = Number(digits);
  if (y < MIN_YEAR || y > MAX_YEAR) return { ok: false, reason: 'invalid_date' };
  const iso = `${digits}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidIsoDate(iso) ? { ok: true, date: iso } : { ok: false, reason: 'invalid_date' };
}

export function parseWrittenDate(text: string, options: WrittenDateOptions = {}): WrittenDate {
  const s = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (s === '') return { ok: false, reason: 'unrecognised' };
  if (BLANK.test(s)) return { ok: false, reason: 'incomplete' };

  const iso = ISO_FORM.exec(s);
  if (iso) return finish(iso[1] ?? '', Number(iso[2]), Number(iso[3]));

  const numeric = NUMERIC_FORM.exec(s);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    const year = numeric[4] ?? '';
    if (year.replace(/^'/, '').length !== 4) return { ok: false, reason: 'two_digit_year' };
    if (a === b || a > 12 || b > 12) {
      // Only one reading can be a real month, or both readings agree.
      return a > 12 ? finish(year, b, a) : finish(year, a, b);
    }
    if (options.numericOrder === 'month_first') return finish(year, a, b);
    if (options.numericOrder === 'day_first') return finish(year, b, a);
    return { ok: false, reason: 'ambiguous_order' };
  }

  for (const form of WORD_FORMS) {
    const m = form.re.exec(s);
    if (!m) continue;
    const month = MONTHS.get(m[form.month] ?? '');
    if (month === undefined) continue;
    return finish(m[form.year] ?? '', month, Number(m[form.day]));
  }

  const worded = ORDINAL_DAY_FORM.exec(s);
  if (worded) {
    const day = ORDINAL_WORDS.get(worded[1] ?? '');
    const month = MONTHS.get(worded[2] ?? '');
    if (day !== undefined && month !== undefined) return finish(worded[3] ?? '', month, day);
  }

  // A month and year with no day ("March 2020") is a real date reference, just not a whole one.
  const monthYear = /^(?:[a-z]+\s+)?([a-z]+)\.?,?\s+'?\d{2,4}$/.exec(s);
  if (monthYear && MONTHS.has(monthYear[1] ?? '')) return { ok: false, reason: 'incomplete' };

  return { ok: false, reason: 'unrecognised' };
}
