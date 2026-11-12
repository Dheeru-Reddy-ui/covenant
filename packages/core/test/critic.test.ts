import { describe, expect, it } from 'vitest';
import { resolveRule } from '../src/dates/resolve';
import { type ExtractionOutcome, extractContract } from '../src/extract';
import type { ToolCallRequest } from '../src/llm';
import { CONTRACT, QUOTES, ScriptedLlm, noticeRule, paymentRule, reading, terms } from './fixtures';

const succeeded = (outcome: ExtractionOutcome) => {
  if (outcome.status !== 'ok') throw new Error(`extraction failed: ${outcome.reason}`);
  return outcome;
};

/** First pass returns `first`; second passes are answered by `second`. */
const scripted = (first: unknown, second: (req: ToolCallRequest) => unknown) =>
  new ScriptedLlm((req) => (req.tool.name === 'record_contract' ? first : second(req)));

describe('critic: second readings of doubtful obligations', () => {
  it('re-reads a low-confidence obligation and keeps it when both readings agree', async () => {
    const low = noticeRule({ confidence: 'low', summary: 'FIRST-READING-SUMMARY' });
    const llm = scripted(reading({ obligations: [low, paymentRule()] }), () => noticeRule());
    const out = succeeded(await extractContract(CONTRACT, llm));

    const [check] = llm.calls('record_clause_rule');
    expect(llm.calls('record_clause_rule')).toHaveLength(1);
    // The second reader sees the clause and what to look for, not the first reading's answer.
    expect(check?.prompt).toContain(QUOTES.notice);
    expect(check?.prompt).toContain('renewal_notice');
    expect(check?.prompt).not.toContain('FIRST-READING-SUMMARY');
    expect(out.obligations[0]).toMatchObject({ status: 'ready', review: [] });
    expect(out.obligations[0]?.secondReading?.offset).toEqual({ count: 90, unit: 'day', direction: 'before' });
    expect(out.secondPasses).toBe(1);
  });

  it('marks the obligation for review when the readings disagree', async () => {
    const llm = scripted(reading({ obligations: [noticeRule({ confidence: 'low' })] }), () =>
      noticeRule({ offset: { count: 60, unit: 'day', direction: 'before' } }),
    );
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.obligations[0]).toMatchObject({ status: 'needs_review', review: [{ reason: 'passes_disagree' }] });
    expect(out.obligations[0]?.secondReading?.offset.count).toBe(60);
  });

  it('never re-reads a confident obligation with no conflict', async () => {
    const llm = scripted(reading(), () => {
      throw new Error('should not be called');
    });
    succeeded(await extractContract(CONTRACT, llm));
    expect(llm.requests).toHaveLength(1);
  });

  it('marks two clauses that set different deadlines for the same duty for review, even when each is read right', async () => {
    const ninety = noticeRule();
    const sixty = noticeRule({ responsibleParty: 'Either party', quote: QUOTES.notice60, offset: { count: 60, unit: 'day', direction: 'before' } });
    const llm = scripted(reading({ obligations: [ninety, sixty] }), (req) => (req.prompt.includes('sixty (60)') && !req.prompt.includes('ninety (90)') ? sixty : ninety));
    const out = succeeded(await extractContract(CONTRACT, llm, { critic: { contextChars: 40 } }));
    expect(llm.calls('record_clause_rule')).toHaveLength(2);
    expect(out.obligations.map((o) => [o.status, o.review.map((r) => r.reason)])).toEqual([
      ['needs_review', ['conflicting_clauses']],
      ['needs_review', ['conflicting_clauses']],
    ]);
  });

  it('settles a conflict that came from a misreading', async () => {
    // The first pass read clause 2.2 twice, once wrongly as 60 days.
    const right = noticeRule();
    const wrong = noticeRule({ offset: { count: 60, unit: 'day', direction: 'before' } });
    const llm = scripted(reading({ obligations: [right, paymentRule(), { ...wrong, quote: `2.2 Renewal. ${QUOTES.renewal}` }] }), () => right);
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.obligations.map((o) => o.status)).toEqual(['ready', 'ready', 'needs_review']);
    expect(out.obligations[2]?.review.map((r) => r.reason)).toEqual(['passes_disagree']);
  });

  it('marks the obligation for review when its second reading fails', async () => {
    const llm = scripted(reading({ obligations: [noticeRule({ confidence: 'low' })] }), () => ({ not: 'a rule' }));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.obligations[0]).toMatchObject({ status: 'needs_review', review: [{ reason: 'second_pass_failed' }] });
  });

  it('stops re-reading at the cap and marks the rest for review', async () => {
    const llm = scripted(reading({ obligations: [noticeRule({ confidence: 'low' }), paymentRule({ confidence: 'low' })] }), (req) =>
      req.prompt.includes('payment') ? paymentRule() : noticeRule(),
    );
    const out = succeeded(await extractContract(CONTRACT, llm, { critic: { maxSecondPasses: 1 } }));
    expect(llm.calls('record_clause_rule')).toHaveLength(1);
    expect(out.obligations.map((o) => [o.status, o.review.map((r) => r.reason)])).toEqual([
      ['ready', []],
      ['needs_review', ['not_rechecked']],
    ]);
  });

  it('marks low-confidence readings for review when the critic is turned off', async () => {
    const llm = new ScriptedLlm(() => reading({ obligations: [noticeRule({ confidence: 'low' })] }));
    const out = succeeded(await extractContract(CONTRACT, llm, { critic: false }));
    expect(llm.requests).toHaveLength(1);
    expect(out.obligations[0]).toMatchObject({ status: 'needs_review', review: [{ reason: 'not_rechecked' }] });
  });
});

describe('critic: second readings of doubtful term facts', () => {
  const lowEffective = { dateText: 'March 1, 2025', event: null, quote: QUOTES.effective, page: 1, confidence: 'low' };

  it('re-reads a low-confidence effective date and keeps it when both readings agree', async () => {
    const llm = scripted(reading(terms({ effectiveDate: lowEffective })), () => terms());
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(llm.calls('record_terms')).toHaveLength(1);
    expect(llm.calls('record_terms')[0]?.prompt).toContain(QUOTES.effective);
    expect(out.effectiveDate).toMatchObject({ status: 'ready', value: '2025-03-01' });
  });

  it('holds the effective date back when the readings disagree, so no deadline is computed from it', async () => {
    const other = { dateText: 'March 2, 2025', event: null, quote: QUOTES.signed, page: 1, confidence: 'high' };
    const llm = scripted(reading(terms({ effectiveDate: lowEffective })), () => terms({ effectiveDate: other }));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.effectiveDate).toMatchObject({ status: 'needs_review', value: null, review: [{ reason: 'passes_disagree' }] });
    expect(out.effectiveDate?.secondReading?.dateText).toBe('March 2, 2025');
    expect(out.contractTerms.effectiveDate).toBeNull();
    const notice = out.obligations.find((o) => o.rule.kind === 'renewal_notice');
    if (!notice) throw new Error('no notice');
    expect(resolveRule(notice.rule, { terms: out.contractTerms, termIndex: 0 })).toMatchObject({ status: 'unresolved' });
  });

  it('re-reads term facts the date engine finds in conflict, and holds them back if the conflict stands', async () => {
    const doc = {
      pages: [
        {
          page: 1,
          text: 'This Agreement is effective as of March 1, 2025. It continues for an initial term of two (2) years, ending on December 31, 2030.',
        },
      ],
    };
    const conflicting = {
      effectiveDate: { dateText: 'March 1, 2025', event: null, quote: 'This Agreement is effective as of March 1, 2025.', page: null, confidence: 'high' },
      term: {
        kind: 'fixed_length',
        length: { count: 2, unit: 'year' },
        endDateText: 'December 31, 2030',
        quote: 'It continues for an initial term of two (2) years, ending on December 31, 2030.',
        page: null,
        confidence: 'high',
      },
      renewal: null,
    };
    const llm = scripted({ ...conflicting, obligations: [] }, () => conflicting);
    const out = succeeded(await extractContract(doc, llm));
    expect(llm.calls('record_terms')).toHaveLength(1);
    expect(out.effectiveDate).toMatchObject({ status: 'needs_review', review: [{ reason: 'conflicting_term_facts' }] });
    expect(out.term).toMatchObject({ status: 'needs_review', review: [{ reason: 'conflicting_term_facts' }] });
    expect(out.contractTerms).toEqual({ effectiveDate: null, initialTerm: null, initialTermEnd: null, renewalTerm: null });
  });
});
