import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { businessCalendar } from '../src/dates/business';
import { compareDates } from '../src/dates/civil';
import { type ResolveContext, type RuleTiming, resolveRule } from '../src/dates/resolve';
import type { ContractTerms } from '../src/dates/terms';
import { contractDateArb } from './arbitraries';

const baseTerms: ContractTerms = {
  effectiveDate: '2024-01-01',
  initialTerm: { count: 1, unit: 'year' },
  initialTermEnd: null,
  renewalTerm: { count: 1, unit: 'year' },
};

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  terms: baseTerms,
  termIndex: 0,
  ...over,
});

const timing = (over: Partial<RuleTiming> = {}): RuleTiming => ({
  anchor: 'term_end',
  offset: { count: 90, unit: 'day', direction: 'before' },
  recurrence: null,
  ...over,
});

const dates = (rule: RuleTiming, c: ResolveContext): string[] => {
  const r = resolveRule(rule, c);
  if (r.status !== 'resolved') throw new Error(`expected dates, got ${r.reason}: ${r.detail}`);
  return r.occurrences.map((o) => o.date);
};

describe('resolveRule: one-off rules', () => {
  it('finds a notice deadline before the end of the term', () => {
    expect(dates(timing(), ctx())).toEqual(['2024-10-02']);
  });

  it('moves the deadline when the contract rolls into the next term', () => {
    expect(dates(timing(), ctx({ termIndex: 1 }))).toEqual(['2025-10-02']);
    expect(dates(timing(), ctx({ termIndex: 2 }))).toEqual(['2026-10-02']);
  });

  it('is one day later under the anniversary convention', () => {
    expect(dates(timing(), ctx({ termEndConvention: 'anniversary' }))).toEqual(['2024-10-03']);
  });

  it('clamps month offsets to the end of a shorter month', () => {
    const terms = { ...baseTerms, effectiveDate: '2024-06-01' }; // term ends 2025-05-31
    const rule = timing({ offset: { count: 3, unit: 'month', direction: 'before' } });
    expect(dates(rule, ctx({ terms }))).toEqual(['2025-02-28']);
  });

  it('applies week and year offsets', () => {
    const weeks = timing({ anchor: 'effective_date', offset: { count: 2, unit: 'week', direction: 'after' } });
    expect(dates(weeks, ctx())).toEqual(['2024-01-15']);
    const years = timing({ anchor: 'effective_date', offset: { count: 2, unit: 'year', direction: 'after' } });
    expect(dates(years, ctx())).toEqual(['2026-01-01']);
  });

  it('counts business days from the day after the anchor', () => {
    const terms = { ...baseTerms, effectiveDate: '2026-11-13' }; // a Friday
    const rule = timing({ anchor: 'effective_date', offset: { count: 10, unit: 'business_day', direction: 'after' } });
    expect(dates(rule, ctx({ terms }))).toEqual(['2026-11-27']);
  });

  it('honours holidays in the supplied calendar', () => {
    const terms = { ...baseTerms, effectiveDate: '2026-11-13' };
    const rule = timing({ anchor: 'effective_date', offset: { count: 1, unit: 'business_day', direction: 'after' } });
    const calendar = businessCalendar({ holidays: ['2026-11-16'] });
    expect(dates(rule, ctx({ terms, calendar }))).toEqual(['2026-11-17']);
  });

  it('resolves "on the effective date" and "at the start of the term"', () => {
    const on = { count: 0, unit: 'day', direction: 'on' } as const;
    expect(dates(timing({ anchor: 'effective_date', offset: on }), ctx())).toEqual(['2024-01-01']);
    expect(dates(timing({ anchor: 'term_start', offset: on }), ctx({ termIndex: 1 }))).toEqual(['2025-01-01']);
  });

  it('explains how it got the date', () => {
    const r = resolveRule(timing(), ctx());
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    const [o] = r.occurrences;
    expect(o).toMatchObject({ date: '2024-10-02', anchorDate: '2024-12-31' });
    expect(o?.trace.join(' ')).toContain('2024-12-31');
    expect(o?.trace.join(' ')).toContain('90');
    expect(r.dependsOn).toEqual(['effectiveDate', 'initialTerm']);
    expect(r.conventions.termEnd).toBe('day_before_anniversary');
  });

  it('flags a date that falls on a weekend, and leaves it there by default', () => {
    // 2024-10-02 is a Wednesday; a 91-day notice lands on Tuesday; 94 days lands on Saturday 2024-09-28.
    const rule = timing({ offset: { count: 94, unit: 'day', direction: 'before' } });
    const r = resolveRule(rule, ctx());
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.occurrences[0]).toMatchObject({ date: '2024-09-28', onBusinessDay: false });
  });

  it('rolls to the earlier business day when asked', () => {
    const rule = timing({ offset: { count: 94, unit: 'day', direction: 'before' } });
    const r = resolveRule(rule, ctx({ roll: 'preceding' }));
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.occurrences[0]).toMatchObject({ date: '2024-09-27', onBusinessDay: true, rolledFrom: '2024-09-28' });
  });
});

describe('resolveRule: refusals', () => {
  it('refuses an outside event until a person supplies its date', () => {
    const rule = timing({ anchor: 'event', offset: { count: 30, unit: 'day', direction: 'after' } });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'needs_event_date' });
    expect(dates(rule, ctx({ eventDate: '2024-03-01' }))).toEqual(['2024-03-31']);
  });

  it('refuses an invalid supplied event date', () => {
    const rule = timing({ anchor: 'event', offset: { count: 30, unit: 'day', direction: 'after' } });
    expect(resolveRule(rule, ctx({ eventDate: '2024-02-30' }))).toMatchObject({
      status: 'unresolved',
      reason: 'invalid_input',
    });
  });

  it('passes on a term-fact problem instead of guessing', () => {
    const terms = { ...baseTerms, effectiveDate: null };
    expect(resolveRule(timing(), ctx({ terms }))).toMatchObject({
      status: 'unresolved',
      reason: 'missing_effective_date',
    });
  });

  it('refuses a recurring anchor with no recurrence', () => {
    const rule = timing({ anchor: 'period_end', offset: { count: 30, unit: 'day', direction: 'after' } });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'invalid_rule' });
  });

  it('refuses a recurrence on a one-off anchor', () => {
    const rule = timing({ recurrence: { every: { count: 1, unit: 'year' }, basis: 'calendar' } });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'invalid_rule' });
  });

  it('refuses "on" with a non-zero count', () => {
    const rule = timing({ offset: { count: 5, unit: 'day', direction: 'on' } });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'invalid_rule' });
  });

  it('refuses a negative or fractional offset', () => {
    expect(resolveRule(timing({ offset: { count: -1, unit: 'day', direction: 'before' } }), ctx())).toMatchObject({
      status: 'unresolved',
      reason: 'invalid_rule',
    });
    expect(resolveRule(timing({ offset: { count: 1.5, unit: 'day', direction: 'before' } }), ctx())).toMatchObject({
      status: 'unresolved',
      reason: 'invalid_rule',
    });
  });

  it('refuses fiscal periods until the fiscal year start is known', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 90, unit: 'day', direction: 'after' },
      recurrence: { every: { count: 1, unit: 'year' }, basis: 'fiscal' },
    });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'needs_fiscal_year' });
  });

  it('refuses calendar periods that do not divide a year', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 5, unit: 'month' }, basis: 'calendar' },
    });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'unsupported_recurrence' });
  });

  it('refuses weekly calendar periods', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'week' }, basis: 'calendar' },
    });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'unsupported_recurrence' });
  });

  it('refuses a window that would produce an unreasonable number of dates', () => {
    const rule = timing({
      anchor: 'period_start',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'week' }, basis: 'contract' },
    });
    const window = { from: '2024-01-01', to: '2060-01-01' };
    expect(resolveRule(rule, ctx({ window }))).toMatchObject({ status: 'unresolved', reason: 'too_many_occurrences' });
  });

  it('refuses a window that runs backwards', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'month' }, basis: 'calendar' },
    });
    const window = { from: '2025-01-01', to: '2024-01-01' };
    expect(resolveRule(rule, ctx({ window }))).toMatchObject({ status: 'unresolved', reason: 'invalid_input' });
  });
});

describe('resolveRule: recurring rules', () => {
  const quarterly: RuleTiming = {
    anchor: 'period_end',
    offset: { count: 30, unit: 'day', direction: 'after' },
    recurrence: { every: { count: 1, unit: 'quarter' }, basis: 'calendar' },
  };

  it('resolves "within 30 days after the end of each calendar quarter"', () => {
    const window = { from: '2026-01-01', to: '2026-12-31' };
    expect(dates(quarterly, ctx({ window }))).toEqual(['2026-01-30', '2026-04-30', '2026-07-30', '2026-10-30']);
  });

  it('labels each occurrence with its period', () => {
    const window = { from: '2026-04-01', to: '2026-04-30' };
    const r = resolveRule(quarterly, ctx({ window }));
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.occurrences).toHaveLength(1);
    expect(r.occurrences[0]).toMatchObject({
      date: '2026-04-30',
      anchorDate: '2026-03-31',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
    });
  });

  it('defaults the window to the current term', () => {
    expect(dates(quarterly, ctx())).toEqual(['2024-04-30', '2024-07-30', '2024-10-30']);
  });

  it('skips periods that ended before the contract took effect', () => {
    // Q4 2023 ended the day before this contract started, so no report is owed for it.
    const window = { from: '2023-06-01', to: '2024-06-30' };
    expect(dates(quarterly, ctx({ window }))).toEqual(['2024-04-30']);
  });

  it('resolves calendar months, half-years and years', () => {
    const on = { count: 0, unit: 'day', direction: 'on' } as const;
    const window = { from: '2024-01-01', to: '2024-12-31' };
    const monthly = timing({ anchor: 'period_end', offset: on, recurrence: { every: { count: 1, unit: 'month' }, basis: 'calendar' } });
    expect(dates(monthly, ctx({ window }))).toEqual([
      '2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30',
      '2024-07-31', '2024-08-31', '2024-09-30', '2024-10-31', '2024-11-30', '2024-12-31',
    ]);
    const half = timing({ anchor: 'period_end', offset: on, recurrence: { every: { count: 6, unit: 'month' }, basis: 'calendar' } });
    expect(dates(half, ctx({ window }))).toEqual(['2024-06-30', '2024-12-31']);
    const yearly = timing({ anchor: 'period_start', offset: on, recurrence: { every: { count: 1, unit: 'year' }, basis: 'calendar' } });
    expect(dates(yearly, ctx({ window: { from: '2024-01-01', to: '2026-06-30' } }))).toEqual([
      '2024-01-01', '2025-01-01', '2026-01-01',
    ]);
  });

  it('resolves fiscal years once the start month is known', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'year' }, basis: 'fiscal' },
    });
    const window = { from: '2024-01-01', to: '2026-12-31' };
    // Fiscal year starting 1 April ends on 31 March.
    expect(dates(rule, ctx({ window, fiscalYearStartMonth: 4 }))).toEqual(['2024-03-31', '2025-03-31', '2026-03-31']);
  });

  it('resolves fiscal quarters', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'quarter' }, basis: 'fiscal' },
    });
    const window = { from: '2024-01-01', to: '2024-12-31' };
    // Fiscal year starting 1 February: quarters end 30 April, 31 July, 31 October, 31 January.
    expect(dates(rule, ctx({ window, fiscalYearStartMonth: 2 }))).toEqual([
      '2024-01-31', '2024-04-30', '2024-07-31', '2024-10-31',
    ]);
  });

  it('measures contract periods from the effective date without drifting', () => {
    const terms = { ...baseTerms, effectiveDate: '2024-01-31' };
    const rule = timing({
      anchor: 'period_start',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'month' }, basis: 'contract' },
    });
    const window = { from: '2024-01-01', to: '2024-05-31' };
    expect(dates(rule, ctx({ terms, window }))).toEqual([
      '2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31',
    ]);
  });

  it('ends each contract year the day before the anniversary', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'year' }, basis: 'contract' },
    });
    const window = { from: '2024-01-01', to: '2026-12-31' };
    expect(dates(rule, ctx({ window }))).toEqual(['2024-12-31', '2025-12-31', '2026-12-31']);
  });

  it('resolves anniversaries, skipping the effective date itself', () => {
    const terms = { ...baseTerms, effectiveDate: '2024-02-29' };
    const rule = timing({
      anchor: 'anniversary',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'year' }, basis: 'contract' },
    });
    const window = { from: '2024-01-01', to: '2028-12-31' };
    expect(dates(rule, ctx({ terms, window }))).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('refuses anniversaries on a calendar basis', () => {
    const rule = timing({
      anchor: 'anniversary',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'year' }, basis: 'calendar' },
    });
    expect(resolveRule(rule, ctx())).toMatchObject({ status: 'unresolved', reason: 'invalid_rule' });
  });

  it('resolves weekly contract periods', () => {
    const rule = timing({
      anchor: 'period_start',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 2, unit: 'week' }, basis: 'contract' },
    });
    const window = { from: '2024-01-01', to: '2024-02-15' };
    expect(dates(rule, ctx({ window }))).toEqual(['2024-01-01', '2024-01-15', '2024-01-29', '2024-02-12']);
  });

  it('never produces a contract period before the effective date', () => {
    const rule = timing({
      anchor: 'period_end',
      offset: { count: 0, unit: 'day', direction: 'on' },
      recurrence: { every: { count: 1, unit: 'month' }, basis: 'contract' },
    });
    const window = { from: '2023-01-01', to: '2024-03-31' };
    expect(dates(rule, ctx({ window }))).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
  });
});

describe('resolveRule properties', () => {
  const unitArb = fc.constantFrom('day', 'week', 'month', 'year', 'business_day') as fc.Arbitrary<
    'day' | 'week' | 'month' | 'year' | 'business_day'
  >;
  const termUnitArb = fc.constantFrom('month', 'year') as fc.Arbitrary<'month' | 'year'>;
  const termsArb: fc.Arbitrary<ContractTerms> = fc.record({
    effectiveDate: contractDateArb,
    initialTerm: fc.record({ count: fc.integer({ min: 1, max: 10 }), unit: termUnitArb }),
    initialTermEnd: fc.constant(null),
    renewalTerm: fc.record({ count: fc.integer({ min: 1, max: 5 }), unit: termUnitArb }),
  });
  const countArb = fc.integer({ min: 1, max: 400 });

  it('a "before" date is never after its anchor and an "after" date never before it', () => {
    fc.assert(
      fc.property(
        termsArb,
        fc.constantFrom('effective_date', 'term_start', 'term_end') as fc.Arbitrary<'effective_date' | 'term_start' | 'term_end'>,
        countArb,
        unitArb,
        fc.constantFrom('before', 'after') as fc.Arbitrary<'before' | 'after'>,
        fc.integer({ min: 0, max: 5 }),
        (terms, anchor, count, unit, direction, termIndex) => {
          const r = resolveRule({ anchor, offset: { count, unit, direction }, recurrence: null }, { terms, termIndex });
          fc.pre(r.status === 'resolved');
          if (r.status !== 'resolved') return;
          expect(r.occurrences).toHaveLength(1);
          const o = r.occurrences[0]!;
          const cmp = compareDates(o.date, o.anchorDate);
          if (direction === 'before') expect(cmp).toBeLessThan(0);
          else expect(cmp).toBeGreaterThan(0);
        },
      ),
    );
  });

  it('a notice deadline moves strictly later with every renewal', () => {
    fc.assert(
      fc.property(termsArb, countArb, unitArb, fc.integer({ min: 0, max: 5 }), (terms, count, unit, k) => {
        const rule: RuleTiming = { anchor: 'term_end', offset: { count, unit, direction: 'before' }, recurrence: null };
        const a = resolveRule(rule, { terms, termIndex: k });
        const b = resolveRule(rule, { terms, termIndex: k + 1 });
        fc.pre(a.status === 'resolved' && b.status === 'resolved');
        if (a.status !== 'resolved' || b.status !== 'resolved') return;
        expect(compareDates(a.occurrences[0]!.date, b.occurrences[0]!.date)).toBeLessThan(0);
      }),
    );
  });

  it('recurring dates come out sorted, unique and inside the window', () => {
    const everyArb = fc.record({
      count: fc.constantFrom(1, 2, 3, 6),
      unit: fc.constantFrom('month', 'quarter', 'year') as fc.Arbitrary<'month' | 'quarter' | 'year'>,
    });
    fc.assert(
      fc.property(
        termsArb,
        everyArb,
        fc.constantFrom('calendar', 'contract') as fc.Arbitrary<'calendar' | 'contract'>,
        fc.constantFrom('period_start', 'period_end') as fc.Arbitrary<'period_start' | 'period_end'>,
        fc.integer({ min: 0, max: 60 }),
        fc.constantFrom('before', 'after') as fc.Arbitrary<'before' | 'after'>,
        contractDateArb,
        fc.integer({ min: 1, max: 1500 }),
        (terms, every, basis, anchor, count, direction, from, span) => {
          const window = { from, to: addSpan(from, span) };
          const r = resolveRule(
            { anchor, offset: { count, unit: 'day', direction }, recurrence: { every, basis } },
            { terms, termIndex: 0, window },
          );
          fc.pre(r.status === 'resolved');
          if (r.status !== 'resolved') return;
          const ds = r.occurrences.map((o) => o.date);
          expect([...ds].sort()).toEqual(ds);
          expect(new Set(ds).size).toBe(ds.length);
          for (const d of ds) {
            expect(compareDates(d, window.from)).toBeGreaterThanOrEqual(0);
            expect(compareDates(d, window.to)).toBeLessThanOrEqual(0);
          }
        },
      ),
    );
  });

  it('gives the same answer every time', () => {
    fc.assert(
      fc.property(termsArb, countArb, unitArb, fc.integer({ min: 0, max: 5 }), (terms, count, unit, termIndex) => {
        const rule: RuleTiming = { anchor: 'term_end', offset: { count, unit, direction: 'before' }, recurrence: null };
        expect(resolveRule(rule, { terms, termIndex })).toEqual(
          resolveRule(structuredClone(rule), { terms: structuredClone(terms), termIndex }),
        );
      }),
    );
  });
});

function addSpan(from: string, days: number): string {
  const ms = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10))) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
