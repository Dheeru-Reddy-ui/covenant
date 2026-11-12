import { describe, expect, it } from 'vitest';
import type { RuleTiming } from '../src/dates/resolve';
import type { ContractTerms } from '../src/dates/terms';
import {
  DEFAULT_DECISION_LEAD_DAYS,
  type NoticeRule,
  type WindowContext,
  noticeWindow,
  parseDecisionInput,
  rolloverCheck,
  rolloverPreview,
} from '../src/decision';

// The fictional sample: effective 1 March 2025, two-year initial term, one-year renewals, 90 days' notice.
const terms: ContractTerms = {
  effectiveDate: '2025-03-01',
  initialTerm: { count: 2, unit: 'year' },
  initialTermEnd: null,
  renewalTerm: { count: 1, unit: 'year' },
};

const beforeEnd = (days: number): RuleTiming => ({ anchor: 'term_end', offset: { count: days, unit: 'day', direction: 'before' }, recurrence: null });
const notice: NoticeRule = { id: 'n90', rule: beforeEnd(90) };
const notice60: NoticeRule = { id: 'n60', rule: beforeEnd(60) };

const ctx = (over: Partial<WindowContext> = {}): WindowContext => ({
  terms,
  autoRenew: true,
  minTermIndex: 0,
  today: '2026-11-12',
  leadDays: DEFAULT_DECISION_LEAD_DAYS,
  ...over,
});

describe('noticeWindow', () => {
  it('is due inside the lead time, with the countdown, the term and when the decision opened', () => {
    expect(noticeWindow([notice], ctx())).toMatchObject({
      status: 'due',
      deadline: '2026-11-30',
      daysLeft: 18,
      decisionOpensOn: '2026-10-01',
      termIndex: 0,
      termEnd: '2027-02-28',
      obligationId: 'n90',
    });
  });

  it('is later while the deadline is further away than the lead time', () => {
    expect(noticeWindow([notice], ctx({ today: '2026-08-01' }))).toMatchObject({ status: 'later', daysLeft: 121 });
  });

  it('counts the deadline day itself as due', () => {
    expect(noticeWindow([notice], ctx({ today: '2026-11-30' }))).toMatchObject({ status: 'due', daysLeft: 0 });
  });

  it('moves to the next term once the deadline passes and the contract renews on its own', () => {
    expect(noticeWindow([notice], ctx({ today: '2026-12-01' }))).toMatchObject({
      status: 'later',
      deadline: '2027-12-01',
      termIndex: 1,
      termEnd: '2028-02-29',
    });
  });

  it('reports a passed deadline when renewal needs a decision', () => {
    expect(noticeWindow([notice], ctx({ today: '2026-12-01', autoRenew: false }))).toMatchObject({
      status: 'passed',
      deadline: '2026-11-30',
      daysLeft: -1,
    });
  });

  it('takes the earliest deadline when clauses give different notice periods: early is the safe mistake', () => {
    expect(noticeWindow([notice60, notice], ctx())).toMatchObject({ deadline: '2026-11-30', obligationId: 'n90' });
  });

  it('follows a term a person marked renewed', () => {
    expect(noticeWindow([notice], ctx({ minTermIndex: 1 }))).toMatchObject({ deadline: '2027-12-01', termIndex: 1, status: 'later' });
  });

  it('says so when there is no notice rule, or no date without guessing', () => {
    expect(noticeWindow([], ctx())).toEqual({ status: 'no_notice_rule' });
    expect(noticeWindow([notice], ctx({ terms: { ...terms, effectiveDate: null } }))).toMatchObject({
      status: 'undated',
      reason: 'missing_effective_date',
      obligationId: 'n90',
    });
  });
});

describe('rolloverCheck', () => {
  it('describes the term that marking the contract renewed would start', () => {
    expect(rolloverCheck(terms, 0)).toEqual({ ok: true, next: { index: 1, number: 2, start: '2027-03-01', end: '2028-02-29' } });
    expect(rolloverCheck(terms, 1)).toMatchObject({ ok: true, next: { number: 3, start: '2028-03-01', end: '2029-02-28' } });
  });

  it('refuses when the contract has no renewal term or the facts are missing', () => {
    expect(rolloverCheck({ ...terms, renewalTerm: null }, 0)).toMatchObject({ ok: false, reason: 'no_renewal_term' });
    expect(rolloverCheck({ ...terms, effectiveDate: null }, 0)).toMatchObject({ ok: false, reason: 'missing_effective_date' });
  });
});

describe('rolloverPreview', () => {
  const payment: RuleTiming = { anchor: 'event', offset: { count: 30, unit: 'day', direction: 'after' }, recurrence: null };
  const insurance: RuleTiming = {
    anchor: 'anniversary',
    offset: { count: 30, unit: 'day', direction: 'after' },
    recurrence: { every: { count: 1, unit: 'year' }, basis: 'contract' },
  };

  it('moves the dates that hang from the term and leaves the rest', () => {
    const preview = rolloverPreview(
      [
        { id: 'notice', rule: beforeEnd(90), eventDate: null },
        { id: 'payment', rule: payment, eventDate: '2026-11-01' },
        { id: 'insurance', rule: insurance, eventDate: null },
      ],
      { terms, autoRenew: true, termIndex: 0, today: '2026-11-12' },
    );
    expect(preview).toEqual([
      { id: 'notice', before: '2026-11-30', after: '2027-12-01', changed: true },
      { id: 'payment', before: '2026-12-01', after: '2026-12-01', changed: false },
      { id: 'insurance', before: '2027-03-31', after: '2027-03-31', changed: false },
    ]);
  });

  it('shows a date appearing or disappearing as null', () => {
    const [row] = rolloverPreview([{ id: 'payment', rule: payment, eventDate: null }], { terms, autoRenew: true, termIndex: 0, today: '2026-11-12' });
    expect(row).toEqual({ id: 'payment', before: null, after: null, changed: false });
  });
});

describe('parseDecisionInput', () => {
  it('accepts an outcome and a rationale, trimmed', () => {
    expect(parseDecisionInput({ outcome: 'renegotiate', rationale: '  Price is 20% above market; ask for a cap.  ' })).toEqual({
      ok: true,
      value: { outcome: 'renegotiate', rationale: 'Price is 20% above market; ask for a cap.' },
    });
  });

  it('needs a real rationale and a known outcome', () => {
    expect(parseDecisionInput({ outcome: 'renew', rationale: 'ok' }).ok).toBe(false);
    expect(parseDecisionInput({ outcome: 'extend', rationale: 'A long enough reason.' }).ok).toBe(false);
    expect(parseDecisionInput(null).ok).toBe(false);
  });
});
