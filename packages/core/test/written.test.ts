import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseWrittenDate } from '../src/dates/written';
import { contractDateArb } from './arbitraries';

const ok = (text: string, options = {}) => {
  const result = parseWrittenDate(text, options);
  return result.ok ? result.date : `fail:${result.reason}`;
};

describe('parseWrittenDate', () => {
  it('reads dates written with the month as a word', () => {
    expect(ok('March 1, 2025')).toBe('2025-03-01');
    expect(ok('March 1st, 2025')).toBe('2025-03-01');
    expect(ok('Mar. 1, 2025')).toBe('2025-03-01');
    expect(ok('Sept 30, 2019')).toBe('2019-09-30');
    expect(ok('1 March 2025')).toBe('2025-03-01');
    expect(ok('1st March, 2025')).toBe('2025-03-01');
    expect(ok('DECEMBER 31, 2006')).toBe('2006-12-31');
    expect(ok('March 1 2025')).toBe('2025-03-01');
  });

  it('reads the "day of" forms contracts like', () => {
    expect(ok('the 1st day of March, 2025')).toBe('2025-03-01');
    expect(ok('this 15th day of June, 2019')).toBe('2019-06-15');
    expect(ok('1st day of March 2025')).toBe('2025-03-01');
    expect(ok('the first day of March, 2025')).toBe('2025-03-01');
    expect(ok('the twenty-second day of July, 2016')).toBe('2016-07-22');
    expect(ok('the thirty-first day of December 2020')).toBe('2020-12-31');
    expect(ok('22nd day of July, A.D. 2016')).toBe('2016-07-22');
  });

  it('reads ISO dates', () => {
    expect(ok('2025-03-01')).toBe('2025-03-01');
  });

  it('reads numeric dates only when the order is certain', () => {
    expect(ok('3/15/2025')).toBe('2025-03-15'); // 15 cannot be a month
    expect(ok('15/3/2025')).toBe('2025-03-15');
    expect(ok('3/3/2025')).toBe('2025-03-03'); // same either way
    expect(ok('3/4/2025')).toBe('fail:ambiguous_order');
    expect(ok('3/4/2025', { numericOrder: 'month_first' })).toBe('2025-03-04');
    expect(ok('3/4/2025', { numericOrder: 'day_first' })).toBe('2025-04-03');
    expect(ok('03.04.2025', { numericOrder: 'day_first' })).toBe('2025-04-03');
  });

  it('refuses two-digit years rather than guess the century', () => {
    expect(ok('3/15/98')).toBe('fail:two_digit_year');
    expect(ok("March 1, '98")).toBe('fail:two_digit_year');
  });

  it('refuses dates with blanks or missing parts', () => {
    expect(ok('____ __, 2020')).toBe('fail:incomplete');
    expect(ok('March __, 2020')).toBe('fail:incomplete');
    expect(ok('[ ], 2020')).toBe('fail:incomplete');
    expect(ok('the ___ day of March, 2020')).toBe('fail:incomplete');
    expect(ok('March 2020')).toBe('fail:incomplete');
  });

  it('refuses dates that do not exist', () => {
    expect(ok('February 30, 2024')).toBe('fail:invalid_date');
    expect(ok('February 29, 2023')).toBe('fail:invalid_date');
    expect(ok('February 29, 2024')).toBe('2024-02-29');
    expect(ok('13/13/2025')).toBe('fail:invalid_date');
  });

  it('refuses anything that is not one written date', () => {
    expect(ok('')).toBe('fail:unrecognised');
    expect(ok('the Effective Date')).toBe('fail:unrecognised');
    expect(ok('upon execution')).toBe('fail:unrecognised');
    expect(ok('March 1, 2025 and April 1, 2025')).toBe('fail:unrecognised');
    expect(ok('Smarch 1, 2025')).toBe('fail:unrecognised');
  });

  it('round-trips every real date through every unambiguous written form', () => {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const SUFFIX: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
    const ordinal = (n: number): string => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${SUFFIX[n % 10] ?? 'th'}`);
    fc.assert(
      fc.property(contractDateArb, (iso) => {
        const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
        const month = MONTHS[m - 1] ?? '';
        const forms = [
          `${month} ${d}, ${y}`,
          `${d} ${month} ${y}`,
          `the ${ordinal(d)} day of ${month}, ${y}`,
          `${month.slice(0, 3)}. ${d}, ${y}`,
          iso,
        ];
        for (const form of forms) expect(ok(form), form).toBe(iso);
        expect(ok(`${m}/${d}/${y}`, { numericOrder: 'month_first' })).toBe(iso);
        expect(ok(`${d}/${m}/${y}`, { numericOrder: 'day_first' })).toBe(iso);
      }),
      { numRuns: 300 },
    );
  });

  it('never returns a date for a numeric form whose order it cannot know', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1990, max: 2060 }), (a, b, y) => {
        fc.pre(a !== b);
        expect(parseWrittenDate(`${a}/${b}/${y}`).ok).toBe(false);
      }),
    );
  });
});
