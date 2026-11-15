import { describe, expect, it } from 'vitest';
import { WEEKENDS_ONLY, calendarOf, describeCalendar, parseHolidayList, readHolidayList } from '../src/dates/holidays';
import type { RuleTiming } from '../src/dates/resolve';
import type { ContractTerms } from '../src/dates/terms';
import { noticeWindow } from '../src/decision';
import { scheduleRule } from '../src/schedule';

const terms: ContractTerms = {
  effectiveDate: '2025-03-03',
  initialTerm: { count: 2, unit: 'year' },
  initialTermEnd: null,
  renewalTerm: { count: 1, unit: 'year' },
};

const parsed = (name: string, text: string) => {
  const r = parseHolidayList(name, text);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.value;
};

describe('parseHolidayList', () => {
  it('reads one day per line with an optional label, sorted and without repeats', () => {
    const list = parsed('Port Ellery 2026 to 2027', '2027-01-01 New Year\'s Day\n\n2026-12-25, Christmas Day\n2026-12-25\n2026-12-28 - Boxing Day (observed)\n');
    expect(list).toEqual({
      name: 'Port Ellery 2026 to 2027',
      holidays: [
        { date: '2026-12-25', label: 'Christmas Day' },
        { date: '2026-12-28', label: 'Boxing Day (observed)' },
        { date: '2027-01-01', label: "New Year's Day" },
      ],
    });
  });

  it('is weekends only when nothing is listed', () => {
    expect(parsed('', '  \n')).toEqual(WEEKENDS_ONLY);
  });

  it('refuses anything that is not a real date, naming the line, and a list with no name', () => {
    const bad = parseHolidayList('x', '2026-12-25\n25 Dec 2026\n2027-02-30 not a day');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toEqual(['line 2: start with a real date written YYYY-MM-DD', 'line 3: start with a real date written YYYY-MM-DD']);
    const unnamed = parseHolidayList(' ', '2026-12-25');
    expect(unnamed.ok).toBe(false);
  });
});

describe('readHolidayList', () => {
  it('falls back to weekends only for anything malformed', () => {
    expect(readHolidayList(null)).toEqual(WEEKENDS_ONLY);
    expect(readHolidayList({ name: 'x', holidays: 'no' })).toEqual(WEEKENDS_ONLY);
    expect(readHolidayList({ name: 'x', holidays: [{ date: 'soon' }] })).toEqual(WEEKENDS_ONLY);
    expect(readHolidayList({ name: 'x', holidays: [{ date: '2026-12-25', label: 'Christmas Day' }] }).holidays).toHaveLength(1);
  });
});

describe('describeCalendar', () => {
  it('names the rule and the list', () => {
    expect(describeCalendar(WEEKENDS_ONLY)).toBe('Business days are Monday to Friday. No holidays are listed for this contract, so none are skipped.');
    expect(describeCalendar(parsed('Port Ellery', '2027-01-01'))).toBe('Business days are Monday to Friday, skipping the 1 holiday in "Port Ellery".');
  });
});

describe('business-day dates with a holiday list', () => {
  // A report due 15 business days after each calendar quarter ends.
  const report: RuleTiming = {
    anchor: 'period_end',
    offset: { count: 15, unit: 'business_day', direction: 'after' },
    recurrence: { every: { count: 1, unit: 'quarter' }, basis: 'calendar' },
  };
  const base = { terms, today: '2026-11-13', autoRenew: true };

  it('for a quarter that ends just before 1 January, the count skips the listed holiday', () => {
    const plain = scheduleRule(report, base);
    expect(plain).toMatchObject({ status: 'upcoming', due: '2027-01-21' });

    const holidays = parsed('Port Ellery 2027', '2027-01-01 New Year\'s Day');
    const withHoliday = scheduleRule(report, { ...base, holidays });
    // 1 January 2027 is a Friday, so the fifteenth business day moves on by one.
    expect(withHoliday).toMatchObject({ status: 'upcoming', due: '2027-01-22' });
    if (withHoliday.status !== 'upcoming') throw new Error('expected a date');
    expect(withHoliday.trace.join('\n')).toContain('Business days are Monday to Friday, skipping the 1 holiday in "Port Ellery 2027".');
    expect(withHoliday.trace.join('\n')).toContain("Skipped 2027-01-01 (New Year's Day)");
  });

  it('a holiday on a weekend changes nothing, and the trace says none were skipped', () => {
    const holidays = parsed('Weekend holiday', '2027-01-02 Saturday');
    const s = scheduleRule(report, { ...base, holidays });
    expect(s).toMatchObject({ due: '2027-01-21' });
    if (s.status !== 'upcoming') throw new Error('expected a date');
    expect(s.trace.join('\n')).not.toContain('Skipped');
  });

  it('with no list, the trace states the weekends-only rule', () => {
    const s = scheduleRule(report, base);
    if (s.status !== 'upcoming') throw new Error('expected a date');
    expect(s.trace.join('\n')).toContain('No holidays are listed for this contract');
  });

  it('counting back for a notice deadline skips holidays too', () => {
    const notice: RuleTiming = { anchor: 'term_end', offset: { count: 40, unit: 'business_day', direction: 'before' }, recurrence: null };
    const ctx = { terms, autoRenew: true, minTermIndex: 0, today: '2026-11-13', leadDays: 60 };
    const plain = noticeWindow([{ id: 'n', rule: notice }], ctx);
    const holidays = parsed('Port Ellery', "2027-01-18 Midwinter Day\n2027-02-15 Founders' Day");
    const shifted = noticeWindow([{ id: 'n', rule: notice }], { ...ctx, holidays });
    // The term ends on Tuesday 2 March 2027; forty business days back is eight weeks, Tuesday 5 January.
    expect(plain).toMatchObject({ deadline: '2027-01-05' });
    // Two weekday holidays fall inside the count, so notice is due two business days earlier.
    expect(shifted).toMatchObject({ deadline: '2027-01-01' });
  });

  it('calendar-day rules are untouched by the list and say nothing about business days', () => {
    const notice: RuleTiming = { anchor: 'term_end', offset: { count: 90, unit: 'day', direction: 'before' }, recurrence: null };
    const holidays = parsed('Port Ellery', '2026-12-25');
    const s = scheduleRule(notice, { ...base, holidays });
    expect(s).toMatchObject({ due: '2026-12-02' });
    if (s.status !== 'upcoming') throw new Error('expected a date');
    expect(s.trace.join('\n')).not.toContain('Business days');
  });

  it('calendarOf feeds the engine', () => {
    expect(calendarOf(parsed('x', '2026-12-25')).holidays.has('2026-12-25')).toBe(true);
  });
});
