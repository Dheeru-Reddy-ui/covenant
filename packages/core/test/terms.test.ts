import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '../src/dates/civil';
import { type ContractTerms, termBounds } from '../src/dates/terms';
import { contractDateArb } from './arbitraries';

const terms = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  effectiveDate: '2024-01-01',
  initialTerm: { count: 1, unit: 'year' },
  initialTermEnd: null,
  renewalTerm: { count: 1, unit: 'year' },
  ...over,
});

const ok = (t: ContractTerms, index: number, convention?: 'day_before_anniversary' | 'anniversary') => {
  const r = termBounds(t, index, convention ? { termEndConvention: convention } : {});
  if (!r.ok) throw new Error(`expected bounds, got ${r.reason}: ${r.detail}`);
  return r.value;
};

describe('termBounds', () => {
  it('ends the initial term the day before the anniversary by default', () => {
    expect(ok(terms(), 0)).toMatchObject({ index: 0, start: '2024-01-01', end: '2024-12-31' });
  });

  it('can end the term on the anniversary instead', () => {
    expect(ok(terms(), 0, 'anniversary')).toMatchObject({ start: '2024-01-01', end: '2025-01-01' });
  });

  it('rolls into renewal terms', () => {
    expect(ok(terms(), 1)).toMatchObject({ index: 1, start: '2025-01-01', end: '2025-12-31' });
    expect(ok(terms(), 2)).toMatchObject({ index: 2, start: '2026-01-01', end: '2026-12-31' });
  });

  it('handles a long initial term followed by shorter renewals', () => {
    const t = terms({ initialTerm: { count: 3, unit: 'year' } });
    expect(ok(t, 0)).toMatchObject({ start: '2024-01-01', end: '2026-12-31' });
    expect(ok(t, 1)).toMatchObject({ start: '2027-01-01', end: '2027-12-31' });
    expect(ok(t, 2)).toMatchObject({ start: '2028-01-01', end: '2028-12-31' });
  });

  it('measures month terms from the effective date, so month ends do not drift', () => {
    const t = terms({
      effectiveDate: '2024-01-31',
      initialTerm: { count: 1, unit: 'month' },
      renewalTerm: { count: 1, unit: 'month' },
    });
    expect(ok(t, 0)).toMatchObject({ start: '2024-01-31', end: '2024-02-28' });
    expect(ok(t, 1)).toMatchObject({ start: '2024-02-29', end: '2024-03-30' });
    // A drifting engine would start this term on 29 March.
    expect(ok(t, 2)).toMatchObject({ start: '2024-03-31', end: '2024-04-29' });
  });

  it('handles day and week terms', () => {
    const t = terms({ initialTerm: { count: 90, unit: 'day' }, renewalTerm: { count: 2, unit: 'week' } });
    expect(ok(t, 0)).toMatchObject({ start: '2024-01-01', end: '2024-03-30' });
    expect(ok(t, 1)).toMatchObject({ start: '2024-03-31', end: '2024-04-13' });
    expect(ok(t, 2)).toMatchObject({ start: '2024-04-14', end: '2024-04-27' });
  });

  it('uses a stated end date over a computed one', () => {
    const t = terms({ effectiveDate: '2024-03-15', initialTerm: null, initialTermEnd: '2025-12-31' });
    expect(ok(t, 0)).toMatchObject({ start: '2024-03-15', end: '2025-12-31' });
    expect(ok(t, 1)).toMatchObject({ start: '2026-01-01', end: '2026-12-31' });
    expect(ok(t, 2)).toMatchObject({ start: '2027-01-01', end: '2027-12-31' });
  });

  it('accepts a stated end date within one day of the computed one, and uses the stated date', () => {
    const t = terms({ initialTermEnd: '2025-01-01' });
    expect(ok(t, 0)).toMatchObject({ start: '2024-01-01', end: '2025-01-01' });
    expect(ok(t, 1)).toMatchObject({ start: '2025-01-02' });
  });

  it('refuses when the stated end date and the term length disagree', () => {
    const r = termBounds(terms({ initialTermEnd: '2025-06-30' }), 0);
    expect(r).toMatchObject({ ok: false, reason: 'conflicting_term_facts' });
  });

  it('refuses without an effective date', () => {
    expect(termBounds(terms({ effectiveDate: null }), 0)).toMatchObject({
      ok: false,
      reason: 'missing_effective_date',
    });
  });

  it('refuses without any way to find the end of the initial term', () => {
    expect(termBounds(terms({ initialTerm: null }), 0)).toMatchObject({
      ok: false,
      reason: 'missing_initial_term',
    });
  });

  it('refuses a renewal term when the contract has none', () => {
    const t = terms({ renewalTerm: null });
    expect(termBounds(t, 0)).toMatchObject({ ok: true });
    expect(termBounds(t, 1)).toMatchObject({ ok: false, reason: 'no_renewal_term' });
  });

  it('refuses a term measured in business days', () => {
    const t = terms({ initialTerm: { count: 30, unit: 'business_day' } });
    expect(termBounds(t, 0)).toMatchObject({ ok: false, reason: 'unsupported_term_unit' });
  });

  it('refuses a zero-length term', () => {
    const t = terms({ initialTerm: { count: 0, unit: 'year' } });
    expect(termBounds(t, 0)).toMatchObject({ ok: false, reason: 'invalid_term_facts' });
  });

  it('refuses an invalid effective date', () => {
    expect(termBounds(terms({ effectiveDate: '2024-02-30' }), 0)).toMatchObject({
      ok: false,
      reason: 'invalid_term_facts',
    });
  });

  it('refuses an end date that is not after the effective date', () => {
    const t = terms({ initialTerm: null, initialTermEnd: '2023-12-31' });
    expect(termBounds(t, 0)).toMatchObject({ ok: false, reason: 'invalid_term_facts' });
  });

  it('refuses a negative or fractional term index', () => {
    expect(termBounds(terms(), -1)).toMatchObject({ ok: false, reason: 'invalid_term_index' });
    expect(termBounds(terms(), 1.5)).toMatchObject({ ok: false, reason: 'invalid_term_index' });
  });

  it('refuses a term that would run past the supported years', () => {
    const t = terms({ effectiveDate: '2290-01-01', initialTerm: { count: 20, unit: 'year' } });
    expect(termBounds(t, 0)).toMatchObject({ ok: false, reason: 'out_of_range' });
  });

  it('records which facts each boundary depends on', () => {
    expect(ok(terms(), 0).dependsOn).toEqual(['effectiveDate', 'initialTerm']);
    expect(ok(terms(), 1).dependsOn).toEqual(['effectiveDate', 'initialTerm', 'renewalTerm']);
    const stated = terms({ initialTerm: null, initialTermEnd: '2025-12-31' });
    expect(ok(stated, 0).dependsOn).toEqual(['effectiveDate', 'initialTermEnd']);
  });
});

describe('termBounds properties', () => {
  const unitArb = fc.constantFrom('day', 'week', 'month', 'year') as fc.Arbitrary<'day' | 'week' | 'month' | 'year'>;
  const durationArb = fc.record({ count: fc.integer({ min: 1, max: 36 }), unit: unitArb });
  const termsArb = fc.record({
    effectiveDate: contractDateArb,
    initialTerm: durationArb,
    initialTermEnd: fc.constant(null),
    renewalTerm: durationArb,
  });

  it('terms are contiguous, ordered and never overlap', () => {
    fc.assert(
      fc.property(termsArb, fc.integer({ min: 0, max: 12 }), (t, k) => {
        const a = termBounds(t, k);
        const b = termBounds(t, k + 1);
        fc.pre(a.ok && b.ok);
        if (!a.ok || !b.ok) return;
        expect(compareDates(a.value.start, a.value.end)).toBeLessThanOrEqual(0);
        expect(b.value.start).toBe(addDays(a.value.end, 1));
        expect(compareDates(a.value.end, b.value.end)).toBeLessThan(0);
      }),
    );
  });

  it('the first term always starts on the effective date', () => {
    fc.assert(
      fc.property(termsArb, (t) => {
        const r = termBounds(t, 0);
        fc.pre(r.ok);
        if (!r.ok) return;
        expect(r.value.start).toBe(t.effectiveDate);
      }),
    );
  });

  it('the anniversary convention only ever moves the end one day later', () => {
    fc.assert(
      fc.property(termsArb, fc.integer({ min: 0, max: 12 }), (t, k) => {
        const a = termBounds(t, k, { termEndConvention: 'day_before_anniversary' });
        const b = termBounds(t, k, { termEndConvention: 'anniversary' });
        fc.pre(a.ok && b.ok);
        if (!a.ok || !b.ok) return;
        expect(b.value.end).toBe(addDays(a.value.end, 1));
        expect(b.value.start).toBe(a.value.start);
      }),
    );
  });

  it('gives the same answer every time', () => {
    fc.assert(
      fc.property(termsArb, fc.integer({ min: 0, max: 12 }), (t, k) => {
        expect(termBounds(t, k)).toEqual(termBounds(structuredClone(t), k));
      }),
    );
  });
});
