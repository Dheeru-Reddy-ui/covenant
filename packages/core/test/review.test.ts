import { describe, expect, it } from 'vitest';
import { type ObligationDecision, applyObligationEdit, canApprove, parseTermsEdit, runReviewStatus } from '../src/review';
import { type ObligationRule, ObligationRuleSchema } from '../src/schema';
import { QUOTES, noticeRule, paymentRule } from './fixtures';

const rule = (over: Record<string, unknown> = {}): ObligationRule => ObligationRuleSchema.parse(noticeRule(over));
const payment = (): ObligationRule => ObligationRuleSchema.parse(paymentRule());

describe('applyObligationEdit', () => {
  it('changes what the person changed and keeps the quote as evidence', () => {
    const r = applyObligationEdit(rule(), { offset: { count: 60, unit: 'day', direction: 'before' }, responsibleParty: 'Customer' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule.offset.count).toBe(60);
    expect(r.rule.responsibleParty).toBe('Customer');
    expect(r.rule.quote).toBe(QUOTES.notice);
    expect(r.rule.anchor).toBe('term_end');
  });

  it('ignores attempts to change the quote, page or confidence', () => {
    const r = applyObligationEdit(rule(), { quote: 'something else entirely', page: 1, confidence: 'low' } as never);
    expect(r.ok && r.rule.quote).toBe(QUOTES.notice);
    expect(r.ok && r.rule.confidence).toBe('high');
    expect(r.ok && r.rule.page).toBe(7);
  });

  it('rejects an edit that breaks the rule, with readable problems', () => {
    const r = applyObligationEdit(rule(), { anchor: 'period_end' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(' ')).toMatch(/recurrence/);
  });

  it('rejects an empty summary and a "before" offset of zero', () => {
    expect(applyObligationEdit(rule(), { summary: '   ' }).ok).toBe(false);
    expect(applyObligationEdit(rule(), { offset: { count: 0, unit: 'day', direction: 'before' } }).ok).toBe(false);
  });

  it('clears the event description when the anchor moves off "event"', () => {
    const r = applyObligationEdit(payment(), { anchor: 'term_end' });
    expect(r.ok && r.rule.anchorDescription).toBe(null);
  });

  it('needs an event description when the anchor moves onto "event"', () => {
    expect(applyObligationEdit(rule(), { anchor: 'event' }).ok).toBe(false);
    const r = applyObligationEdit(rule(), { anchor: 'event', anchorDescription: 'date of the notice' });
    expect(r.ok && r.rule.anchorDescription).toBe('date of the notice');
  });

  it('trims text fields', () => {
    const r = applyObligationEdit(rule(), { summary: '  Send the notice.  ', responsibleParty: ' Supplier ' });
    expect(r.ok && [r.rule.summary, r.rule.responsibleParty]).toEqual(['Send the notice.', 'Supplier']);
  });
});

describe('canApprove', () => {
  const cases: Array<[ObligationDecision, 'ready' | 'needs_review', boolean]> = [
    ['pending', 'ready', true],
    ['pending', 'needs_review', false],
    ['edited', 'needs_review', true],
    ['edited', 'ready', true],
    ['approving', 'ready', false],
    ['approved', 'ready', false],
    ['rejected', 'ready', false],
  ];
  it.each(cases)('%s and %s gives %s', (decision, extractorStatus, expected) => {
    expect(canApprove({ decision, extractorStatus })).toBe(expected);
  });
});

describe('runReviewStatus', () => {
  it('is approved only once every obligation is approved or rejected', () => {
    expect(runReviewStatus(['approved', 'rejected'])).toBe('approved');
    expect(runReviewStatus(['approved', 'pending'])).toBe('needs_review');
    expect(runReviewStatus(['approved', 'approving'])).toBe('needs_review');
    expect(runReviewStatus(['edited'])).toBe('needs_review');
  });

  it('needs review when nothing was found, so a person still looks', () => {
    expect(runReviewStatus([])).toBe('needs_review');
  });
});

describe('parseTermsEdit', () => {
  const valid = {
    effectiveDate: '2025-03-01',
    initialTerm: { count: 2, unit: 'year' },
    initialTermEnd: null,
    renewalTerm: { count: 1, unit: 'year' },
  };

  it('accepts complete facts and unknown ones', () => {
    expect(parseTermsEdit(valid)).toEqual({ ok: true, terms: valid });
    const unknown = { effectiveDate: null, initialTerm: null, initialTermEnd: null, renewalTerm: null };
    expect(parseTermsEdit(unknown)).toEqual({ ok: true, terms: unknown });
  });

  it('rejects dates that do not exist', () => {
    const r = parseTermsEdit({ ...valid, effectiveDate: '2025-02-30' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join(' ')).toMatch(/effectiveDate/);
  });

  it('rejects a term length and end date that disagree', () => {
    const r = parseTermsEdit({ ...valid, initialTermEnd: '2026-06-30' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join(' ')).toMatch(/disagrees/);
  });

  it('rejects terms measured in business days and malformed input', () => {
    expect(parseTermsEdit({ ...valid, initialTerm: { count: 30, unit: 'business_day' } }).ok).toBe(false);
    expect(parseTermsEdit({ ...valid, renewalTerm: { count: 0, unit: 'year' } }).ok).toBe(false);
    expect(parseTermsEdit('2025-03-01').ok).toBe(false);
  });
});
