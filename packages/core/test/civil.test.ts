import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  addYears,
  compareDates,
  dayOfWeek,
  daysInMonth,
  diffDays,
  endOfMonth,
  fromDayNumber,
  isLeapYear,
  isValidIsoDate,
  startOfMonth,
  toDayNumber,
} from '../src/dates/civil';
import { isoDateArb } from './arbitraries';

// Independent oracle: the JS Date object in UTC. The engine itself never uses Date.
const MS_PER_DAY = 86_400_000;
const utc = (iso: string): number =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const oracleAddDays = (iso: string, n: number): string =>
  new Date(utc(iso) + n * MS_PER_DAY).toISOString().slice(0, 10);

describe('isValidIsoDate', () => {
  it.each(['2024-02-29', '2000-02-29', '1900-01-01', '2199-12-31', '2026-11-11'])('accepts %s', (s) => {
    expect(isValidIsoDate(s)).toBe(true);
  });

  it.each([
    '2023-02-29', // not a leap year
    '1900-02-29', // century, not a leap year
    '2024-13-01',
    '2024-00-10',
    '2024-01-32',
    '2024-04-31',
    '2024-1-1',
    '24-01-01',
    '2024-01-01T00:00:00Z',
    ' 2024-01-01',
    '2024/01/01',
    '',
    'tomorrow',
  ])('rejects %s', (s) => {
    expect(isValidIsoDate(s)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidIsoDate(undefined)).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(20240101)).toBe(false);
  });

  it('rejects years outside the supported range', () => {
    expect(isValidIsoDate('1799-12-31')).toBe(false);
    expect(isValidIsoDate('2301-01-01')).toBe(false);
  });
});

describe('day numbers', () => {
  it('counts days from 1970-01-01', () => {
    expect(toDayNumber('1970-01-01')).toBe(0);
    expect(toDayNumber('1970-01-02')).toBe(1);
    expect(toDayNumber('1969-12-31')).toBe(-1);
    expect(toDayNumber('2000-03-01')).toBe(11_017);
  });

  it('throws on an invalid date instead of guessing', () => {
    expect(() => toDayNumber('2023-02-29')).toThrow(TypeError);
    expect(() => toDayNumber('not a date')).toThrow(TypeError);
  });

  it('agrees with the UTC oracle for every date', () => {
    fc.assert(
      fc.property(isoDateArb, (d) => {
        expect(toDayNumber(d)).toBe(utc(d) / MS_PER_DAY);
      }),
    );
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(isoDateArb, (d) => {
        expect(fromDayNumber(toDayNumber(d))).toBe(d);
      }),
    );
  });
});

describe('addDays / diffDays', () => {
  it('crosses month, year and leap boundaries', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addDays('2024-12-31', -90)).toBe('2024-10-02');
  });

  it('agrees with the UTC oracle', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: -20_000, max: 20_000 }), (d, n) => {
        fc.pre(isValidIsoDate(oracleAddDays(d, n)));
        expect(addDays(d, n)).toBe(oracleAddDays(d, n));
      }),
    );
  });

  it('is undone by the opposite step', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: -20_000, max: 20_000 }), (d, n) => {
        fc.pre(isValidIsoDate(oracleAddDays(d, n)));
        expect(addDays(addDays(d, n), -n)).toBe(d);
        expect(diffDays(d, addDays(d, n))).toBe(n);
      }),
    );
  });

  it('refuses to leave the supported range', () => {
    expect(() => addDays('2300-12-31', 1)).toThrow(RangeError);
    expect(() => addDays('1800-01-01', -1)).toThrow(RangeError);
  });

  it('refuses a fractional step', () => {
    expect(() => addDays('2024-01-01', 1.5)).toThrow(TypeError);
  });
});

describe('dayOfWeek', () => {
  it('knows fixed days (0 = Sunday)', () => {
    expect(dayOfWeek('1970-01-01')).toBe(4); // Thursday
    expect(dayOfWeek('2026-11-11')).toBe(3); // Wednesday
    expect(dayOfWeek('2026-11-14')).toBe(6); // Saturday
    expect(dayOfWeek('2026-11-15')).toBe(0); // Sunday
  });

  it('agrees with the UTC oracle', () => {
    fc.assert(
      fc.property(isoDateArb, (d) => {
        expect(dayOfWeek(d)).toBe(new Date(utc(d)).getUTCDay());
      }),
    );
  });
});

describe('months', () => {
  it('knows leap years', () => {
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2025)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
  });

  it('knows month lengths', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2024, 4)).toBe(30);
    expect(daysInMonth(2024, 12)).toBe(31);
  });

  it('finds month edges', () => {
    expect(startOfMonth('2024-02-17')).toBe('2024-02-01');
    expect(endOfMonth('2024-02-17')).toBe('2024-02-29');
    expect(endOfMonth('2023-02-01')).toBe('2023-02-28');
    expect(endOfMonth('2024-12-31')).toBe('2024-12-31');
  });
});

describe('addMonths', () => {
  it('keeps the day of month when it exists', () => {
    expect(addMonths('2024-12-15', 1)).toBe('2025-01-15');
    expect(addMonths('2024-01-15', -1)).toBe('2023-12-15');
    expect(addMonths('2024-06-01', 12)).toBe('2025-06-01');
    expect(addMonths('2024-06-01', 0)).toBe('2024-06-01');
  });

  it('clamps to the last day of a shorter month', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonths('2024-11-30', 3)).toBe('2025-02-28');
    expect(addMonths('2025-05-31', -3)).toBe('2025-02-28');
  });

  it('handles 29 February across years', () => {
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 48)).toBe('2028-02-29');
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });

  it('lands in the right month with the day clamped, never spilling over', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: -600, max: 600 }), (d, n) => {
        const y = Number(d.slice(0, 4));
        const m = Number(d.slice(5, 7));
        const day = Number(d.slice(8, 10));
        const absolute = y * 12 + (m - 1) + n;
        const wantY = Math.floor(absolute / 12);
        const wantM = (absolute % 12) + 1;
        fc.pre(wantY >= 1800 && wantY <= 2300);

        const got = addMonths(d, n);
        expect(Number(got.slice(0, 4))).toBe(wantY);
        expect(Number(got.slice(5, 7))).toBe(wantM);
        expect(Number(got.slice(8, 10))).toBe(Math.min(day, daysInMonth(wantY, wantM)));
      }),
    );
  });

  it('is undone by the opposite step when the day exists in every month', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: -600, max: 600 }), (d, n) => {
        fc.pre(Number(d.slice(8, 10)) <= 28);
        fc.pre(isValidIsoDate(addMonths(d, n)));
        expect(addMonths(addMonths(d, n), -n)).toBe(d);
      }),
    );
  });

  it('never reorders two dates', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, fc.integer({ min: -240, max: 240 }), (a, b, n) => {
        const [lo, hi] = compareDates(a, b) <= 0 ? [a, b] : [b, a];
        expect(compareDates(addMonths(lo, n), addMonths(hi, n))).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('treats a year as twelve months', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: -40, max: 40 }), (d, n) => {
        expect(addYears(d, n)).toBe(addMonths(d, n * 12));
      }),
    );
  });
});

describe('compareDates', () => {
  it('orders dates', () => {
    expect(compareDates('2024-01-01', '2024-01-02')).toBeLessThan(0);
    expect(compareDates('2024-01-02', '2024-01-01')).toBeGreaterThan(0);
    expect(compareDates('2024-01-01', '2024-01-01')).toBe(0);
  });
});
