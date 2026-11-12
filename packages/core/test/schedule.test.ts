import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '../src/dates/civil';
import type { RuleTiming } from '../src/dates/resolve';
import type { ContractTerms } from '../src/dates/terms';
import { type ScheduleContext, currentTermIndex, describeTiming, scheduleRule } from '../src/schedule';

// The fictional sample contract: effective 1 March 2025, two-year initial term, one-year renewals.
const terms: ContractTerms = {
  effectiveDate: '2025-03-01',
  initialTerm: { count: 2, unit: 'year' },
  initialTermEnd: null,
  renewalTerm: { count: 1, unit: 'year' },
};

const ctx = (over: Partial<ScheduleContext> = {}): ScheduleContext => ({ terms, today: '2026-11-12', autoRenew: true, ...over });

type Rule = RuleTiming & { anchorDescription?: string | null };

const notice: Rule = { anchor: 'term_end', offset: { count: 90, unit: 'day', direction: 'before' }, recurrence: null };
const payment: Rule = {
  anchor: 'event',
  anchorDescription: 'date of the invoice',
  offset: { count: 30, unit: 'day', direction: 'after' },
  recurrence: null,
};
const reporting: Rule = {
  anchor: 'period_end',
  offset: { count: 15, unit: 'business_day', direction: 'after' },
  recurrence: { every: { count: 1, unit: 'quarter' }, basis: 'calendar' },
};
const insurance: Rule = {
  anchor: 'anniversary',
  offset: { count: 30, unit: 'day', direction: 'after' },
  recurrence: { every: { count: 1, unit: 'year' }, basis: 'contract' },
};
const priceChange: Rule = {
  anchor: 'anniversary',
  offset: { count: 60, unit: 'day', direction: 'before' },
  recurrence: { every: { count: 1, unit: 'year' }, basis: 'contract' },
};
const serviceCredit: Rule = {
  anchor: 'period_end',
  offset: { count: 45, unit: 'day', direction: 'after' },
  recurrence: { every: { count: 1, unit: 'month' }, basis: 'calendar' },
};

describe('currentTermIndex', () => {
  const index = (over: Parameters<typeof currentTermIndex>[2] & { today: string }, t: ContractTerms = terms) => {
    const r = currentTermIndex(t, over.today, over);
    if (!r.ok) throw new Error(`expected an index, got ${r.reason}`);
    return r.value;
  };

  it('is the initial term while it runs, including its last day', () => {
    expect(index({ today: '2026-11-12', autoRenew: true })).toBe(0);
    expect(index({ today: '2027-02-28', autoRenew: true })).toBe(0);
  });

  it('rolls into renewal terms as time passes when the contract renews on its own', () => {
    expect(index({ today: '2027-03-01', autoRenew: true })).toBe(1);
    expect(index({ today: '2029-06-01', autoRenew: true })).toBe(3);
  });

  it('stays put when renewal needs a decision', () => {
    expect(index({ today: '2029-06-01', autoRenew: false })).toBe(0);
  });

  it('stays on the last term when the contract does not renew', () => {
    expect(index({ today: '2030-01-01', autoRenew: true }, { ...terms, renewalTerm: null })).toBe(0);
  });

  it('starts from a term a person has already marked renewed', () => {
    expect(index({ today: '2026-11-12', autoRenew: false, minTermIndex: 2 })).toBe(2);
  });

  it('is the initial term before the contract starts', () => {
    expect(index({ today: '2024-01-01', autoRenew: true })).toBe(0);
  });

  it('refuses when the effective date is unknown', () => {
    const r = currentTermIndex({ ...terms, effectiveDate: null }, '2026-11-12', { autoRenew: true });
    expect(r).toMatchObject({ ok: false, reason: 'missing_effective_date' });
  });
});

describe('scheduleRule: deadlines tied to the term', () => {
  it('finds the notice deadline in the current term, with the working shown', () => {
    const s = scheduleRule(notice, ctx());
    expect(s).toMatchObject({ status: 'upcoming', due: '2026-11-30', termIndex: 0 });
    if (s.status !== 'upcoming') return;
    expect(s.trace.join(' | ')).toContain('2027-02-28');
    expect(s.trace.at(-1)).toContain('2026-11-30');
  });

  it('moves to the next term once this term\'s deadline has passed and the contract renews', () => {
    // The first renewal term ends 2028-02-29 (a leap year), so its deadline is 2027-12-01.
    expect(scheduleRule(notice, ctx({ today: '2026-12-01' }))).toMatchObject({ status: 'upcoming', due: '2027-12-01', termIndex: 1 });
  });

  it('reports a passed deadline when renewal needs a decision', () => {
    expect(scheduleRule(notice, ctx({ today: '2026-12-01', autoRenew: false }))).toMatchObject({ status: 'past', due: '2026-11-30' });
  });

  it('counts today as upcoming', () => {
    expect(scheduleRule(notice, ctx({ today: '2026-11-30' }))).toMatchObject({ status: 'upcoming', due: '2026-11-30' });
  });

  it('refuses rather than guesses when a term fact is missing', () => {
    expect(scheduleRule(notice, ctx({ terms: { ...terms, effectiveDate: null } }))).toMatchObject({
      status: 'undated',
      reason: 'missing_effective_date',
    });
    expect(scheduleRule(notice, ctx({ terms: { ...terms, initialTerm: null } }))).toMatchObject({
      status: 'undated',
      reason: 'missing_initial_term',
    });
  });

  it('dates an effective-date deadline once, upcoming or past', () => {
    const rule: Rule = { anchor: 'effective_date', offset: { count: 30, unit: 'day', direction: 'after' }, recurrence: null };
    expect(scheduleRule(rule, ctx())).toMatchObject({ status: 'past', due: '2025-03-31' });
    expect(scheduleRule(rule, ctx({ today: '2025-03-10' }))).toMatchObject({ status: 'upcoming', due: '2025-03-31' });
  });
});

describe('scheduleRule: deadlines that run from an outside event', () => {
  it('stays undated until a person supplies the event date', () => {
    expect(scheduleRule(payment, ctx())).toMatchObject({ status: 'undated', reason: 'needs_event_date' });
    expect(scheduleRule(payment, ctx({ eventDate: null }))).toMatchObject({ status: 'undated', reason: 'needs_event_date' });
  });

  it('dates it from the supplied event, and says when it has passed', () => {
    expect(scheduleRule(payment, ctx({ eventDate: '2026-11-01' }))).toMatchObject({ status: 'upcoming', due: '2026-12-01' });
    expect(scheduleRule(payment, ctx({ eventDate: '2026-09-01' }))).toMatchObject({ status: 'past', due: '2026-10-01' });
  });

  it('does not need the term facts', () => {
    expect(scheduleRule(payment, ctx({ eventDate: '2026-11-01', terms: { ...terms, effectiveDate: null } }))).toMatchObject({
      status: 'upcoming',
      due: '2026-12-01',
    });
  });
});

describe('scheduleRule: recurring deadlines', () => {
  it('gives the next quarterly report date and the ones after it', () => {
    const s = scheduleRule(reporting, ctx());
    // Q3 ended 2026-09-30, so its report (2026-10-21) has passed. Q4 ends 2026-12-31: 15 business days later is 2027-01-21.
    expect(s).toMatchObject({ status: 'upcoming', due: '2027-01-21', termIndex: 0 });
    if (s.status !== 'upcoming') return;
    expect(s.later[0]).toBe('2027-04-21');
    expect(s.later.length).toBeLessThanOrEqual(2);
  });

  it('finds the next anniversary deadline even when it falls in the next term', () => {
    expect(scheduleRule(insurance, ctx())).toMatchObject({ status: 'upcoming', due: '2027-03-31', termIndex: 1 });
    expect(scheduleRule(priceChange, ctx())).toMatchObject({ status: 'upcoming', due: '2026-12-31', termIndex: 0 });
  });

  it('reports the last date when the contract will not run into another term', () => {
    expect(scheduleRule(insurance, ctx({ autoRenew: false }))).toMatchObject({ status: 'past', due: '2026-03-31' });
  });

  it('gives the next monthly service credit claim date', () => {
    // September ends 2026-09-30; 45 days later is 2026-11-14, still ahead of today.
    expect(scheduleRule(serviceCredit, ctx())).toMatchObject({ status: 'upcoming', due: '2026-11-14' });
  });

  it('lists as many later dates as asked', () => {
    const s = scheduleRule(serviceCredit, ctx({ upcomingCount: 4 }));
    expect(s.status === 'upcoming' && s.later).toEqual(['2026-12-15', '2027-01-14', '2027-02-14']);
  });

  it('refuses a fiscal-year rule until the fiscal year is known', () => {
    const fiscal: Rule = { ...reporting, recurrence: { every: { count: 1, unit: 'quarter' }, basis: 'fiscal' } };
    expect(scheduleRule(fiscal, ctx())).toMatchObject({ status: 'undated', reason: 'needs_fiscal_year' });
  });

  it('never reports an upcoming date before today, or a past one after it', () => {
    const rules = [notice, reporting, insurance, priceChange, serviceCredit];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 365 * 12 }), fc.integer({ min: 0, max: rules.length - 1 }), fc.boolean(), (days, which, autoRenew) => {
        const today = addDays('2024-01-01', days);
        const rule = rules[which] as Rule;
        const s = scheduleRule(rule, ctx({ today, autoRenew }));
        if (s.status === 'upcoming') {
          expect(compareDates(s.due, today)).toBeGreaterThanOrEqual(0);
          for (const later of s.later) expect(compareDates(later, s.due)).toBeGreaterThan(0);
        }
        if (s.status === 'past') expect(compareDates(s.due, today)).toBeLessThan(0);
      }),
    );
  });
});

describe('describeTiming', () => {
  it.each([
    [notice, '90 days before the end of the current term'],
    [payment, '30 days after the date of the invoice'],
    [reporting, '15 business days after the end of each calendar quarter'],
    [insurance, '30 days after each anniversary of the effective date'],
    [priceChange, '60 days before each anniversary of the effective date'],
    [serviceCredit, '45 days after the end of each calendar month'],
  ])('describes %j', (rule, text) => {
    expect(describeTiming(rule)).toBe(text);
  });

  it('handles "on", singular units, other periods and events with their own article', () => {
    expect(describeTiming({ anchor: 'effective_date', offset: { count: 0, unit: 'day', direction: 'on' }, recurrence: null })).toBe(
      'on the effective date',
    );
    expect(describeTiming({ anchor: 'term_start', offset: { count: 1, unit: 'week', direction: 'after' }, recurrence: null })).toBe(
      '1 week after the start of the current term',
    );
    expect(
      describeTiming({
        anchor: 'period_start',
        offset: { count: 5, unit: 'business_day', direction: 'after' },
        recurrence: { every: { count: 2, unit: 'month' }, basis: 'contract' },
      }),
    ).toBe('5 business days after the start of every 2 contract months');
    expect(
      describeTiming({ anchor: 'event', anchorDescription: 'receipt of a written request', offset: { count: 10, unit: 'day', direction: 'after' }, recurrence: null }),
    ).toBe('10 days after receipt of a written request');
    expect(
      describeTiming({ anchor: 'event', anchorDescription: 'The closing', offset: { count: 1, unit: 'month', direction: 'before' }, recurrence: null }),
    ).toBe('1 month before the closing');
    expect(describeTiming({ anchor: 'event', anchorDescription: null, offset: { count: 2, unit: 'year', direction: 'after' }, recurrence: null })).toBe(
      '2 years after an event the contract names',
    );
  });
});
