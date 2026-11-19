import { describe, expect, it } from 'vitest';
import type { RuleTiming } from '../src/dates/resolve';
import type { ContractTerms } from '../src/dates/terms';
import {
  DEFAULT_DECISION_LEAD_DAYS,
  decisionFollowUp,
  decisionForTerm,
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

  it('leaves out a rule that runs from an event: the window has no event date, so it can never count down to it', () => {
    const fromEvent: NoticeRule = { id: 'e30', rule: { anchor: 'event', offset: { count: 30, unit: 'day', direction: 'after' }, recurrence: null } };
    expect(noticeWindow([fromEvent], ctx())).toEqual({ status: 'no_notice_rule' });
    expect(noticeWindow([fromEvent, notice], ctx())).toMatchObject({ status: 'due', deadline: '2026-11-30', obligationId: 'n90' });
    expect(noticeWindow([fromEvent, notice], ctx({ terms: { ...terms, effectiveDate: null } }))).toMatchObject({ status: 'undated', obligationId: 'n90' });
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
    // The problem names the rule exactly, so a person or an agent can fix it on the first try.
    expect(parseDecisionInput({ outcome: 'renew', rationale: 'MCP test' })).toEqual({ ok: false, problems: ['rationale: give a reason of at least 10 characters'] });
    expect(parseDecisionInput({ outcome: 'extend', rationale: 'A long enough reason.' }).ok).toBe(false);
    expect(parseDecisionInput(null).ok).toBe(false);
  });
});

describe('decisionForTerm and decisionFollowUp', () => {
  const decisions = [
    { outcome: 'renew', termIndex: 0, decidedAtMs: 100 },
    { outcome: 'terminate', termIndex: 0, decidedAtMs: 300 },
    { outcome: 'renegotiate', termIndex: 1, decidedAtMs: 200 },
  ];

  it('gives the latest decision recorded for a term, or null', () => {
    expect(decisionForTerm(decisions, 0)).toMatchObject({ outcome: 'terminate', decidedAtMs: 300 });
    expect(decisionForTerm(decisions, 1)).toMatchObject({ outcome: 'renegotiate' });
    expect(decisionForTerm(decisions, 2)).toBeNull();
    expect(decisionForTerm([], 0)).toBeNull();
  });

  it('says what is still to do after each outcome', () => {
    // Renewing an auto-renewing contract needs no notice; ending it does, by the deadline.
    expect(decisionFollowUp('renew', { autoRenew: true, windowStatus: 'due' })).toBe('none');
    expect(decisionFollowUp('renew', { autoRenew: false, windowStatus: 'due' })).toBe('send_notice');
    expect(decisionFollowUp('terminate', { autoRenew: true, windowStatus: 'due' })).toBe('send_notice');
    expect(decisionFollowUp('terminate', { autoRenew: false, windowStatus: 'due' })).toBe('none');
    expect(decisionFollowUp('renegotiate', { autoRenew: true, windowStatus: 'due' })).toBe('watch_deadline');
    // Once the deadline has passed, nothing can be sent for this term.
    expect(decisionFollowUp('terminate', { autoRenew: true, windowStatus: 'passed' })).toBe('too_late');
    expect(decisionFollowUp('renew', { autoRenew: true, windowStatus: 'passed' })).toBe('none');
  });
});
