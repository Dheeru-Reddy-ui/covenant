import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  WEEKDAYS,
  addBusinessDays,
  businessCalendar,
  countBusinessDays,
  isBusinessDay,
  rollToBusinessDay,
} from '../src/dates/business';
import { addDays, compareDates } from '../src/dates/civil';
import { isoDateArb } from './arbitraries';

// 2026-11-13 is a Friday, 14 a Saturday, 15 a Sunday, 16 a Monday.
const FRI = '2026-11-13';
const SAT = '2026-11-14';
const SUN = '2026-11-15';
const MON = '2026-11-16';
const TUE = '2026-11-17';

describe('isBusinessDay', () => {
  it('excludes weekends', () => {
    expect(isBusinessDay(FRI, WEEKDAYS)).toBe(true);
    expect(isBusinessDay(SAT, WEEKDAYS)).toBe(false);
    expect(isBusinessDay(SUN, WEEKDAYS)).toBe(false);
    expect(isBusinessDay(MON, WEEKDAYS)).toBe(true);
  });

  it('excludes holidays', () => {
    const cal = businessCalendar({ holidays: [MON] });
    expect(isBusinessDay(MON, cal)).toBe(false);
    expect(isBusinessDay(TUE, cal)).toBe(true);
  });

  it('supports a Friday and Saturday weekend', () => {
    const cal = businessCalendar({ weekend: [5, 6] });
    expect(isBusinessDay(FRI, cal)).toBe(false);
    expect(isBusinessDay(SUN, cal)).toBe(true);
  });
});

describe('businessCalendar', () => {
  it('rejects a calendar with no working days', () => {
    expect(() => businessCalendar({ weekend: [0, 1, 2, 3, 4, 5, 6] })).toThrow(RangeError);
  });

  it('rejects an invalid holiday instead of ignoring it', () => {
    expect(() => businessCalendar({ holidays: ['2026-02-30'] })).toThrow(TypeError);
  });

  it('rejects a weekday outside 0 to 6', () => {
    expect(() => businessCalendar({ weekend: [7] })).toThrow(RangeError);
  });
});

describe('addBusinessDays', () => {
  it('skips the weekend going forward', () => {
    expect(addBusinessDays(FRI, 1, WEEKDAYS)).toBe(MON);
    expect(addBusinessDays(FRI, 5, WEEKDAYS)).toBe('2026-11-20');
    expect(addBusinessDays(FRI, 10, WEEKDAYS)).toBe('2026-11-27');
  });

  it('skips the weekend going backward', () => {
    expect(addBusinessDays(MON, -1, WEEKDAYS)).toBe(FRI);
    expect(addBusinessDays(MON, -5, WEEKDAYS)).toBe('2026-11-09');
  });

  it('counts from a weekend day without counting it', () => {
    expect(addBusinessDays(SAT, 1, WEEKDAYS)).toBe(MON);
    expect(addBusinessDays(SUN, 1, WEEKDAYS)).toBe(MON);
    expect(addBusinessDays(SAT, -1, WEEKDAYS)).toBe(FRI);
  });

  it('skips holidays', () => {
    const cal = businessCalendar({ holidays: [MON] });
    expect(addBusinessDays(FRI, 1, cal)).toBe(TUE);
  });

  it('leaves the date alone for zero days, even on a weekend', () => {
    expect(addBusinessDays(SAT, 0, WEEKDAYS)).toBe(SAT);
  });

  it('refuses a fractional count', () => {
    expect(() => addBusinessDays(FRI, 0.5, WEEKDAYS)).toThrow(TypeError);
  });

  it('always lands on a business day, exactly n business days away', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: 1, max: 400 }), (d, n) => {
        const forward = addBusinessDays(d, n, WEEKDAYS);
        expect(isBusinessDay(forward, WEEKDAYS)).toBe(true);
        expect(countBusinessDays(d, forward, WEEKDAYS)).toBe(n);

        const back = addBusinessDays(d, -n, WEEKDAYS);
        expect(isBusinessDay(back, WEEKDAYS)).toBe(true);
        expect(countBusinessDays(back, d, WEEKDAYS)).toBe(isBusinessDay(d, WEEKDAYS) ? n : n - 1);
      }),
    );
  });

  it('is undone by the opposite step when starting on a business day', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: -400, max: 400 }), (d, n) => {
        fc.pre(isBusinessDay(d, WEEKDAYS));
        expect(addBusinessDays(addBusinessDays(d, n, WEEKDAYS), -n, WEEKDAYS)).toBe(d);
      }),
    );
  });

  it('moves strictly later as the count grows', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: 0, max: 300 }), (d, n) => {
        const a = addBusinessDays(d, n, WEEKDAYS);
        const b = addBusinessDays(d, n + 1, WEEKDAYS);
        expect(compareDates(a, b)).toBeLessThan(0);
      }),
    );
  });

  it('never takes fewer calendar days than business days', () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: 1, max: 300 }), (d, n) => {
        expect(compareDates(addBusinessDays(d, n, WEEKDAYS), addDays(d, n))).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('rollToBusinessDay', () => {
  it('leaves a business day alone', () => {
    expect(rollToBusinessDay(FRI, 'preceding', WEEKDAYS)).toBe(FRI);
    expect(rollToBusinessDay(FRI, 'following', WEEKDAYS)).toBe(FRI);
  });

  it('rolls a weekend day in the chosen direction', () => {
    expect(rollToBusinessDay(SAT, 'preceding', WEEKDAYS)).toBe(FRI);
    expect(rollToBusinessDay(SUN, 'preceding', WEEKDAYS)).toBe(FRI);
    expect(rollToBusinessDay(SAT, 'following', WEEKDAYS)).toBe(MON);
  });

  it('rolls past a holiday', () => {
    const cal = businessCalendar({ holidays: [FRI] });
    expect(rollToBusinessDay(SAT, 'preceding', cal)).toBe('2026-11-12');
  });
});
