import { describe, expect, it } from 'vitest';
import type { ExtractionOutcome } from '../../packages/core/src';
import type { CuadContract } from '../src/cuad';
import {
  aggregate,
  ourExpiration,
  ourNoticePeriod,
  parseGoldDate,
  parseGoldDurations,
  sameDuration,
  scoreContract,
  spansOverlap,
} from '../src/score';

describe('parseGoldDate', () => {
  it('reads CUAD m/d/yy answers and their blanks', () => {
    expect(parseGoldDate('4/1/18')).toEqual({ kind: 'date', month: 4, day: 1, yy: 18 });
    expect(parseGoldDate('12/31/2006')).toEqual({ kind: 'date', month: 12, day: 31, yy: 6 });
    expect(parseGoldDate('[]/[]/2020')).toEqual({ kind: 'blank' });
    expect(parseGoldDate('[]/[]/19[]')).toEqual({ kind: 'blank' });
    expect(parseGoldDate('Perpetual')).toEqual({ kind: 'perpetual' });
    expect(parseGoldDate('')).toEqual({ kind: 'none' });
    expect(parseGoldDate('upon termination')).toEqual({ kind: 'other' });
  });
});

describe('parseGoldDurations', () => {
  it('reads the ways CUAD writes periods', () => {
    expect(parseGoldDurations('successive 1 year')).toEqual({ kind: 'durations', values: [{ count: 1, unit: 'year' }] });
    expect(parseGoldDurations('succesive 1 year')).toEqual({ kind: 'durations', values: [{ count: 1, unit: 'year' }] });
    expect(parseGoldDurations('(6) months')).toEqual({ kind: 'durations', values: [{ count: 6, unit: 'month' }] });
    expect(parseGoldDurations('60) days')).toEqual({ kind: 'durations', values: [{ count: 60, unit: 'day' }] });
    expect(parseGoldDurations('three (3) years')).toEqual({ kind: 'durations', values: [{ count: 3, unit: 'year' }] });
    expect(parseGoldDurations('3 Months')).toEqual({ kind: 'durations', values: [{ count: 3, unit: 'month' }] });
    expect(parseGoldDurations('180 days / 6 months')).toEqual({
      kind: 'durations',
      values: [
        { count: 180, unit: 'day' },
        { count: 6, unit: 'month' },
      ],
    });
    expect(parseGoldDurations('6 months; 12 months').kind).toBe('durations');
    expect(parseGoldDurations('[]')).toEqual({ kind: 'blank' });
    expect(parseGoldDurations('perpetual')).toEqual({ kind: 'perpetual' });
    expect(parseGoldDurations('7/22/2019; 7/22/2022')).toEqual({ kind: 'other' });
  });
});

describe('sameDuration', () => {
  it('treats 12 months as 1 year and 2 weeks as 14 days, but keeps business days apart', () => {
    expect(sameDuration({ count: 12, unit: 'month' }, { count: 1, unit: 'year' })).toBe(true);
    expect(sameDuration({ count: 2, unit: 'week' }, { count: 14, unit: 'day' })).toBe(true);
    expect(sameDuration({ count: 90, unit: 'day' }, { count: 3, unit: 'month' })).toBe(false);
    expect(sameDuration({ count: 10, unit: 'business_day' }, { count: 10, unit: 'day' })).toBe(false);
  });
});

describe('spansOverlap', () => {
  it('needs half of the shorter span to be shared', () => {
    expect(spansOverlap([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toBe(true);
    expect(spansOverlap([{ start: 0, end: 100 }], [{ start: 90, end: 130 }])).toBe(false);
    expect(spansOverlap([{ start: 0, end: 100 }], [{ start: 80, end: 120 }])).toBe(true);
    expect(spansOverlap([], [{ start: 0, end: 10 }])).toBe(false);
  });
});

// ---- A hand-built outcome, shaped like extractContract's, over a one-page CUAD-like text.

const TEXT =
  'This Agreement is effective as of January 1, 2020. It continues for three (3) years. ' +
  'It renews automatically for successive one (1) year terms unless either party gives ninety (90) days written notice before the end of the then-current term.';
const at = (needle: string) => {
  const start = TEXT.indexOf(needle);
  return { status: 'verified' as const, page: 1, pageEnd: 1, ambiguous: false, occurrences: 1, match: { pageStart: 1, pageEnd: 1, startOffset: start, endOffset: start + needle.length } };
};
const EFFECTIVE = 'This Agreement is effective as of January 1, 2020.';
const TERM = 'It continues for three (3) years.';
const RENEWAL = 'It renews automatically for successive one (1) year terms';
const NOTICE = 'unless either party gives ninety (90) days written notice before the end of the then-current term.';

function outcome(over: Partial<Extract<ExtractionOutcome, { status: 'ok' }>> = {}): ExtractionOutcome {
  const confidence = 'high' as const;
  return {
    status: 'ok',
    model: 'm',
    extractorVersion: 1,
    schemaVersion: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    calls: 1,
    effectiveDate: {
      status: 'ready',
      value: '2020-01-01',
      reading: { dateText: 'January 1, 2020', event: null, quote: EFFECTIVE, page: null, confidence },
      location: at(EFFECTIVE),
      review: [],
      secondReading: null,
    },
    term: {
      status: 'ready',
      value: { kind: 'fixed_length', length: { count: 3, unit: 'year' }, endDate: null },
      reading: { kind: 'fixed_length', length: { count: 3, unit: 'year' }, endDateText: null, quote: TERM, page: null, confidence },
      location: at(TERM),
      review: [],
      secondReading: null,
    },
    renewal: {
      status: 'ready',
      value: { automatic: true, length: { count: 1, unit: 'year' } },
      reading: { automatic: true, length: { count: 1, unit: 'year' }, quote: RENEWAL, page: null, confidence },
      location: at(RENEWAL),
      review: [],
      secondReading: null,
    },
    contractTerms: { effectiveDate: '2020-01-01', initialTerm: { count: 3, unit: 'year' }, initialTermEnd: null, renewalTerm: { count: 1, unit: 'year' } },
    obligations: [
      {
        id: 'o0',
        status: 'ready',
        rule: {
          kind: 'renewal_notice',
          responsibleParty: 'Either party',
          summary: 'Give notice.',
          anchor: 'term_end',
          anchorDescription: null,
          offset: { count: 90, unit: 'day', direction: 'before' },
          recurrence: null,
          quote: NOTICE,
          page: null,
          confidence,
        },
        location: at(NOTICE),
        review: [],
        secondReading: null,
      },
    ],
    rejected: [],
    grounding: { quotesReturned: 4, quotesVerified: 4 },
    secondPasses: 0,
    repaired: false,
    ...over,
  };
}

const cuad = (answers: Partial<CuadContract['answers']>): CuadContract => ({
  id: 'C1',
  text: TEXT,
  spans: {
    'Effective Date': [{ start: TEXT.indexOf('January 1, 2020'), end: TEXT.indexOf('January 1, 2020') + 15 }],
    'Expiration Date': [{ start: TEXT.indexOf(TERM), end: TEXT.indexOf(TERM) + TERM.length }],
    'Renewal Term': [{ start: TEXT.indexOf(RENEWAL), end: TEXT.indexOf(RENEWAL) + RENEWAL.length }],
    'Notice Period To Terminate Renewal': [],
  },
  answers: { 'Effective Date': '', 'Expiration Date': '', 'Renewal Term': '', 'Notice Period To Terminate Renewal': '', ...answers },
});

describe('scoreContract', () => {
  it('scores a fully right extraction as exact, recalled and answered', () => {
    const scores = scoreContract(cuad({ 'Effective Date': '1/1/20', 'Expiration Date': '12/31/22', 'Renewal Term': 'successive 1 year', 'Notice Period To Terminate Renewal': '90 days' }), outcome());
    expect(scores.map((s) => [s.label, s.goldClass, s.answer, s.exact, s.recall])).toEqual([
      ['Effective Date', 'scorable', 'value', true, true],
      ['Expiration Date', 'scorable', 'value', true, true],
      ['Renewal Term', 'scorable', 'value', true, true],
      ['Notice Period To Terminate Renewal', 'scorable', 'value', true, null],
    ]);
    expect(scores[1]?.matchedConvention).toBe('day_before_anniversary');
  });

  it('accepts the anniversary convention for expiration dates and says so', () => {
    const [, expiration] = scoreContract(cuad({ 'Expiration Date': '1/1/23' }), outcome());
    expect(expiration).toMatchObject({ exact: true, matchedConvention: 'anniversary' });
  });

  it('counts an abstention as a miss with its reason, never as a match', () => {
    const base = outcome();
    if (base.status !== 'ok') throw new Error('fixture');
    const notice = base.obligations[0];
    if (!notice) throw new Error('fixture');
    const withheld = outcome({ obligations: [{ ...notice, status: 'needs_review', review: [{ reason: 'passes_disagree', detail: '' }] }] });
    expect(ourNoticePeriod(withheld)).toEqual({ kind: 'abstained', why: 'passes_disagree' });
    const [, , , score] = scoreContract(cuad({ 'Notice Period To Terminate Renewal': '90 days' }), withheld);
    expect(score).toMatchObject({ answer: 'abstained', exact: false, why: 'passes_disagree' });
  });

  it('treats a perpetual expiration as a value to match', () => {
    const perpetual = outcome({
      term: {
        status: 'ready',
        value: { kind: 'until_terminated' },
        reading: { kind: 'until_terminated', length: null, endDateText: null, quote: TERM, page: null, confidence: 'high' },
        location: at(TERM),
        review: [],
        secondReading: null,
      },
    });
    expect(ourExpiration(perpetual)).toEqual({ kind: 'value', value: { perpetual: true } });
    expect(scoreContract(cuad({ 'Expiration Date': 'perpetual' }), perpetual)[1]).toMatchObject({ goldClass: 'scorable', exact: true });
  });

  it('credits withholding a date the contract left blank', () => {
    const blankRun = outcome({ effectiveDate: null });
    const [effective] = scoreContract(cuad({ 'Effective Date': '[]/[]/2020' }), blankRun);
    expect(effective).toMatchObject({ goldClass: 'blank', answer: 'none', exact: null });
    expect(aggregate([effective].filter((s) => s !== undefined))).toMatchObject({ blankGold: 1, blankWithheld: 1, scorable: 0 });
  });

  it('scores a failed extraction as no answer everywhere', () => {
    const failed: ExtractionOutcome = { status: 'failed', reason: 'llm_error', detail: 'x', model: 'm', extractorVersion: 1, schemaVersion: 1, usage: { inputTokens: 0, outputTokens: 0 }, calls: 1 };
    const scores = scoreContract(cuad({ 'Effective Date': '1/1/20' }), failed);
    expect(scores.map((s) => s.answer)).toEqual(['none', 'none', 'none', 'none']);
    expect(aggregate(scores)).toMatchObject({ scorable: 1, exact: 0, noAnswer: 1, clauseGold: 3, clauseHits: 0 });
  });
});
