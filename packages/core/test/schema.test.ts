import { describe, expect, it } from 'vitest';
import {
  ClauseSchema,
  ContractTermsSchema,
  OBLIGATION_KINDS,
  ObligationRuleSchema,
  obligationRuleJsonSchema,
} from '../src/schema';

const rule = (over: Record<string, unknown> = {}) => ({
  kind: 'renewal_notice',
  responsibleParty: 'Customer',
  summary: 'Give notice of non-renewal 90 days before the term ends.',
  anchor: 'term_end',
  anchorDescription: null,
  offset: { count: 90, unit: 'day', direction: 'before' },
  recurrence: null,
  quote: 'written notice at least ninety (90) days before the end of the then-current term',
  page: 4,
  confidence: 'high',
  ...over,
});

const accepts = (value: unknown): boolean => ObligationRuleSchema.safeParse(value).success;

describe('ObligationRuleSchema', () => {
  it('accepts a well-formed rule', () => {
    expect(accepts(rule())).toBe(true);
  });

  it('covers the six obligation types in scope', () => {
    expect(OBLIGATION_KINDS).toEqual([
      'renewal_notice',
      'payment',
      'price_change',
      'reporting_deliverable',
      'audit_insurance',
      'service_credit',
    ]);
    for (const kind of OBLIGATION_KINDS) {
      expect(accepts(rule({ kind }))).toBe(true);
    }
  });

  it('rejects a calendar date smuggled in as an extra field', () => {
    expect(accepts(rule({ dueDate: '2025-10-02' }))).toBe(false);
    expect(accepts(rule({ offset: { count: 90, unit: 'day', direction: 'before', date: '2025-10-02' } }))).toBe(false);
  });

  it('rejects an unknown kind, unit, direction or anchor', () => {
    expect(accepts(rule({ kind: 'indemnity' }))).toBe(false);
    expect(accepts(rule({ offset: { count: 1, unit: 'fortnight', direction: 'before' } }))).toBe(false);
    expect(accepts(rule({ offset: { count: 1, unit: 'day', direction: 'around' } }))).toBe(false);
    expect(accepts(rule({ anchor: 'signing' }))).toBe(false);
  });

  it('rejects a negative, fractional or absurd offset count', () => {
    for (const count of [-1, 1.5, 100_000]) {
      expect(accepts(rule({ offset: { count, unit: 'day', direction: 'before' } }))).toBe(false);
    }
  });

  it('requires a zero count with "on" and a positive count otherwise', () => {
    expect(accepts(rule({ offset: { count: 0, unit: 'day', direction: 'on' } }))).toBe(true);
    expect(accepts(rule({ offset: { count: 5, unit: 'day', direction: 'on' } }))).toBe(false);
    expect(accepts(rule({ offset: { count: 0, unit: 'day', direction: 'before' } }))).toBe(false);
  });

  it('requires a recurrence for period and anniversary anchors, and forbids one elsewhere', () => {
    const quarterly = { every: { count: 1, unit: 'quarter' }, basis: 'calendar' };
    const contractYear = { every: { count: 1, unit: 'year' }, basis: 'contract' };
    expect(accepts(rule({ anchor: 'period_end', recurrence: quarterly }))).toBe(true);
    expect(accepts(rule({ anchor: 'period_end', recurrence: null }))).toBe(false);
    expect(accepts(rule({ anchor: 'term_end', recurrence: quarterly }))).toBe(false);
    expect(accepts(rule({ anchor: 'anniversary', recurrence: contractYear }))).toBe(true);
    expect(accepts(rule({ anchor: 'anniversary', recurrence: quarterly }))).toBe(false);
  });

  it('requires a description of the event when the anchor is an outside event', () => {
    expect(accepts(rule({ anchor: 'event', anchorDescription: null }))).toBe(false);
    expect(accepts(rule({ anchor: 'event', anchorDescription: 'receipt of a valid invoice' }))).toBe(true);
  });

  it('rejects an empty quote and a page below 1', () => {
    expect(accepts(rule({ quote: '' }))).toBe(false);
    expect(accepts(rule({ page: 0 }))).toBe(false);
    expect(accepts(rule({ page: null }))).toBe(true);
  });
});

describe('obligationRuleJsonSchema', () => {
  it('is a JSON Schema object naming every rule field as required', () => {
    const schema = obligationRuleJsonSchema() as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(new Set(schema.required)).toEqual(
      new Set([
        'kind',
        'responsibleParty',
        'summary',
        'anchor',
        'anchorDescription',
        'offset',
        'recurrence',
        'quote',
        'page',
        'confidence',
      ]),
    );
    expect(Object.keys(schema.properties ?? {})).not.toContain('dueDate');
  });

  it('tells the model, field by field, the rules it cannot see in the shape', () => {
    const schema = obligationRuleJsonSchema() as { properties?: Record<string, { description?: string }> };
    const describe = (field: string): string => schema.properties?.[field]?.description ?? '';
    for (const field of ['kind', 'responsibleParty', 'summary', 'anchor', 'anchorDescription', 'offset', 'recurrence', 'quote', 'page', 'confidence']) {
      expect(describe(field), `${field} has no description`).not.toBe('');
    }
    // The first live call attached a recurrence to a term_end deadline. Say why that is wrong.
    expect(describe('recurrence')).toMatch(/null/i);
    expect(describe('recurrence')).toMatch(/term_end/);
    expect(describe('anchor')).toMatch(/renew/i);
    expect(describe('quote')).toMatch(/character for character/i);
  });

  it('survives a JSON round trip, so it can be sent as a tool schema', () => {
    const schema = obligationRuleJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe('ClauseSchema', () => {
  it('accepts a located clause and rejects a backwards page range', () => {
    const clause = { id: 'c1', heading: '12. Term', quote: 'some clause text', pageStart: 3, pageEnd: 4 };
    expect(ClauseSchema.safeParse(clause).success).toBe(true);
    expect(ClauseSchema.safeParse({ ...clause, pageStart: 4, pageEnd: 3 }).success).toBe(false);
  });
});

describe('ContractTermsSchema', () => {
  it('accepts known and unknown facts', () => {
    const terms = {
      effectiveDate: '2024-01-01',
      initialTerm: { count: 3, unit: 'year' },
      initialTermEnd: null,
      renewalTerm: null,
    };
    expect(ContractTermsSchema.safeParse(terms).success).toBe(true);
  });

  it('rejects a date that does not exist', () => {
    const terms = { effectiveDate: '2024-02-30', initialTerm: null, initialTermEnd: null, renewalTerm: null };
    expect(ContractTermsSchema.safeParse(terms).success).toBe(false);
  });
});
