import { describe, expect, it } from 'vitest';
import { draftText } from '../src/notice';
import { type IncidentFact, type MeasureContext, creditAmount, dateOfMs, draftClaim, leverageSummary, measureServiceLevel } from '../src/sla';

const at = (iso: string): number => Date.parse(`${iso}Z`);
const ctx: MeasureContext = { termStart: '2025-03-03', termEnd: '2027-03-02', today: '2026-11-15', nowMs: at('2026-11-15T12:00:00') };

const incident = (key: string, created: string, resolved: string | null = null): IncidentFact => ({ key, createdMs: at(created), resolvedMs: resolved === null ? null : at(resolved) });

const countRule = {
  metric: 'incident_count' as const,
  threshold: { count: 1, unit: 'incident' as const },
  period: 'month' as const,
  claim: { quote: 'q', location: {} as never, count: 30, unit: 'day' as const, from: 'period_end' as const },
};

describe('dateOfMs', () => {
  it('gives the UTC date of a moment', () => {
    expect(dateOfMs(at('2026-11-15T23:59:59'))).toBe('2026-11-15');
    expect(dateOfMs(at('2026-11-16T00:00:00'))).toBe('2026-11-16');
  });
});

describe('measureServiceLevel: incident count', () => {
  const incidents = [
    incident('CON-3', '2026-11-03T08:00:00', '2026-11-03T11:00:00'),
    incident('CON-9', '2026-11-12T09:00:00'),
    incident('CON-2', '2026-10-20T09:00:00', '2026-10-20T10:00:00'),
    incident('OLD-1', '2024-06-01T09:00:00', '2024-06-01T10:00:00'),
  ];

  it('counts per period inside the term and reports each period over the cap with its work items and claim deadline', () => {
    const m = measureServiceLevel(countRule, incidents, ctx);
    expect(m).toEqual({
      status: 'measured',
      incidents: 3,
      observed: '3 incidents this term; 1 month over the limit of 1.',
      breaches: [
        {
          periodLabel: 'November 2026',
          workItems: ['CON-3', 'CON-9'],
          detail: '2 incidents in November 2026; the contract allows 1.',
          // Thirty days after the month ends.
          claimBy: '2026-12-30',
          claimOpen: true,
        },
      ],
    });
  });

  it('reports no breach when every period is within the cap', () => {
    const m = measureServiceLevel(countRule, incidents.slice(1), ctx);
    expect(m).toMatchObject({ status: 'measured', incidents: 2, breaches: [], observed: '2 incidents this term; no month went over the limit of 1.' });
  });

  it('closes the claim window once the deadline has passed, and has none when the contract sets no limit', () => {
    const old = [incident('A-1', '2026-06-02T09:00:00', '2026-06-02T10:00:00'), incident('A-2', '2026-06-20T09:00:00', '2026-06-20T10:00:00')];
    const m = measureServiceLevel(countRule, old, ctx);
    if (m.status !== 'measured') throw new Error('expected a measurement');
    expect(m.breaches[0]).toMatchObject({ claimBy: '2026-07-30', claimOpen: false });
    const open = measureServiceLevel({ ...countRule, claim: null }, old, ctx);
    if (open.status !== 'measured') throw new Error('expected a measurement');
    expect(open.breaches[0]).toMatchObject({ claimBy: null, claimOpen: null });
  });

  it('groups by quarter when the clause says so', () => {
    const m = measureServiceLevel({ ...countRule, period: 'quarter', threshold: { count: 2, unit: 'incident' } }, incidents, ctx);
    if (m.status !== 'measured') throw new Error('expected a measurement');
    expect(m.breaches.map((b) => b.periodLabel)).toEqual(['Q4 2026']);
  });

  it('will not count without a period', () => {
    expect(measureServiceLevel({ ...countRule, period: null }, incidents, ctx).status).toBe('cannot_measure');
  });
});

describe('measureServiceLevel: resolution time', () => {
  const rule = { metric: 'resolution_time' as const, threshold: { count: 4, unit: 'hour' as const }, period: null, claim: { quote: 'q', location: {} as never, count: 10, unit: 'business_day' as const, from: 'incident' as const } };

  it('times each incident from created to resolved, and open ones up to now', () => {
    const m = measureServiceLevel(
      rule,
      [incident('CON-3', '2026-11-03T08:00:00', '2026-11-03T11:00:00'), incident('CON-7', '2026-11-05T08:00:00', '2026-11-05T14:30:00'), incident('CON-9', '2026-11-15T09:00:00')],
      ctx,
    );
    expect(m).toMatchObject({ status: 'measured', incidents: 3, observed: '3 incidents this term; 1 over the limit of 4 hours.' });
    if (m.status !== 'measured') throw new Error('expected a measurement');
    expect(m.breaches).toEqual([
      // Resolved Thursday 5 November; ten business days later is Thursday 19 November.
      { periodLabel: null, workItems: ['CON-7'], detail: 'CON-7 took 6.5 hours; the contract allows 4.', claimBy: '2026-11-19', claimOpen: true },
    ]);
  });

  it('counts an incident still open past the limit as a breach', () => {
    const m = measureServiceLevel(rule, [incident('CON-9', '2026-11-15T02:00:00')], ctx);
    if (m.status !== 'measured') throw new Error('expected a measurement');
    expect(m.breaches[0]?.detail).toBe('CON-9 has been open for 10 hours; the contract allows 4.');
  });

  it('measures in business days with the calendar', () => {
    const m = measureServiceLevel({ ...rule, threshold: { count: 2, unit: 'business_day' } }, [incident('CON-3', '2026-11-06T08:00:00', '2026-11-11T08:00:00')], ctx);
    if (m.status !== 'measured') throw new Error('expected a measurement');
    // Friday to Wednesday is three business days.
    expect(m.breaches[0]?.detail).toBe('CON-3 took 3 business days; the contract allows 2.');
  });

  it('says business hours cannot be measured here', () => {
    const m = measureServiceLevel({ ...rule, threshold: { count: 8, unit: 'business_hour' } }, [], ctx);
    expect(m).toMatchObject({ status: 'cannot_measure' });
  });
});

describe('measureServiceLevel: what Jira cannot measure', () => {
  it('reports uptime, response time and anything else as not measurable, never an estimate', () => {
    for (const metric of ['uptime', 'response_time', 'other'] as const) {
      const m = measureServiceLevel({ metric, threshold: { count: 99.5, unit: 'percent' }, period: 'month', claim: null }, [incident('X-1', '2026-11-03T08:00:00')], ctx);
      expect(m.status).toBe('cannot_measure');
      if (m.status === 'cannot_measure') expect(m.reason).toContain('cannot be measured here');
    }
  });
});

describe('creditAmount', () => {
  const breaches = [
    { periodLabel: 'November 2026', workItems: ['A', 'B'], detail: '', claimBy: null, claimOpen: null },
    { periodLabel: 'October 2026', workItems: ['C', 'D'], detail: '', claimBy: null, claimOpen: null },
  ];
  const fee = { minor: 12_000_000, currency: 'EUR' };

  it('is the stated percentage of the stated fee, per breached period or per breach', () => {
    // 5% of a EUR 10,000 monthly fee, for two months.
    expect(creditAmount({ percent: 5, of: 'monthly_fee', per: 'period' }, breaches, fee)).toEqual({ minor: 100_000, currency: 'EUR' });
    expect(creditAmount({ percent: 2, of: 'annual_fee', per: 'breach' }, breaches, fee)).toEqual({ minor: 480_000, currency: 'EUR' });
    expect(creditAmount({ percent: 10, of: 'quarterly_fee', per: 'period' }, breaches.slice(0, 1), fee)).toEqual({ minor: 300_000, currency: 'EUR' });
  });

  it('is null, so the formula is quoted instead, when anything needed is missing', () => {
    expect(creditAmount({ percent: 5, of: 'monthly_fee', per: 'period' }, breaches, null)).toBeNull();
    expect(creditAmount({ percent: null, of: null, per: null }, breaches, fee)).toBeNull();
    expect(creditAmount({ percent: 5, of: 'other', per: 'period' }, breaches, fee)).toBeNull();
    expect(creditAmount({ percent: 5, of: 'monthly_fee', per: null }, breaches, fee)).toBeNull();
    expect(creditAmount({ percent: 5, of: 'monthly_fee', per: 'period' }, [], fee)).toBeNull();
    expect(creditAmount(null, breaches, fee)).toBeNull();
  });
});

describe('draftClaim', () => {
  const base = {
    fileName: 'sample-quillfeather-msa.docx',
    supplier: 'Quillfeather Systems BV',
    commitment: { quote: 'Supplier shall ensure that no more than one (1) Severity 1 incident occurs in any calendar month.', where: 'clause 3.3, Word file', clause: 'clause 3.3' },
    credit: { quote: 'Customer may claim a service credit of five percent (5%) of the monthly Fees for that month.', where: 'clause 3.4, Word file', clause: 'clause 3.4' },
    claimClause: { quote: 'Customer must claim a service credit within thirty (30) days after the end of the month.', where: 'clause 3.5, Word file' },
    breaches: [{ periodLabel: 'November 2026', workItems: ['CON-3', 'CON-9'], detail: '2 incidents in November 2026; the contract allows 1.', claimBy: '2026-12-30', claimOpen: true }],
    claimBy: '2026-12-30',
  };

  it('cites the clause, lists the breaching work items and states the amount when the fee is known', () => {
    const text = draftText(draftClaim({ ...base, amount: { minor: 50_000, currency: 'EUR' } }));
    expect(text).toContain('DRAFT FOR REVIEW');
    expect(text).toContain(base.commitment.quote);
    expect(text).toContain('Work items: CON-3, CON-9.');
    expect(text).toContain('we claim a service credit of EUR 500.');
    expect(text).toContain('Claim deadline: 2026-12-30');
  });

  it('quotes the formula and leaves the amount blank when the fee is not known', () => {
    const text = draftText(draftClaim({ ...base, amount: null }));
    expect(text).toContain(base.credit.quote);
    expect(text).toContain('[amount: work it out from the formula above]');
    expect(text).not.toMatch(/EUR \d/);
  });

  it('the letter cites clauses as the contract numbers them, never Jira keys of the contract, file types or pages', () => {
    const draft = draftClaim({ ...base, amount: null });
    const letter = draft.lines.filter((l) => l.style === 'text' || l.style === 'heading').map((l) => l.text);
    expect(letter).toContain('Subject: Service credit claim');
    expect(letter).toContain('We refer to the agreement (sample-quillfeather-msa.docx). Under clause 3.3, you committed:');
    expect(letter).toContain('Under clause 3.4, the agreement provides:');
    expect(letter.join('\n')).not.toContain('Word file');
    const bare = draftClaim({ ...base, amount: null, commitment: { ...base.commitment, clause: null }, credit: { ...base.credit, clause: null } });
    expect(draftText(bare)).toContain('(sample-quillfeather-msa.docx). You committed:');
    expect(draftText(bare)).toContain('\nThe agreement provides:');
  });
});

describe('leverageSummary', () => {
  it('puts the deadline, the value, each service level and what is owed on one page', () => {
    const measurement = measureServiceLevel(countRule, [incident('CON-3', '2026-11-03T08:00:00'), incident('CON-9', '2026-11-12T09:00:00')], ctx);
    const text = draftText(
      leverageSummary({
        contractTitle: 'Quillfeather MSA',
        deadline: '2026-12-02',
        daysLeft: 17,
        termEnd: '2027-03-02',
        yearlyValue: { minor: 12_000_000, currency: 'EUR' },
        records: [
          { summary: 'No more than one Severity 1 incident a month', where: 'clause 3.3', measurement, credit: { minor: 50_000, currency: 'EUR' } },
          { summary: '99.5% availability', where: 'clause 3.1', measurement: { status: 'cannot_measure', reason: 'Uptime cannot be measured here.' }, credit: null },
        ],
      }),
    );
    expect(text).toContain('Notice deadline 2026-12-02 (17 days left); the current term ends 2027-03-02.');
    expect(text).toContain('Value: EUR 120,000 a year.');
    expect(text).toContain('2 incidents in November 2026; the contract allows 1. (CON-3, CON-9); claim by 2026-12-30');
    expect(text).toContain('Service credits claimable: EUR 500.');
    expect(text).toContain('Uptime cannot be measured here.');
    expect(text).toContain("In short: 1 breach of the contract's own service levels this term");
  });
});
