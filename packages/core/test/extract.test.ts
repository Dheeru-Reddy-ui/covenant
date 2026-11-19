import { describe, expect, it } from 'vitest';
import { resolveRule } from '../src/dates/resolve';
import { EXTRACTOR_VERSION, type ExtractionOutcome, extractContract, namesTheTerm } from '../src/extract';
import { SCHEMA_VERSION } from '../src/schema';
import { CONTRACT, QUOTES, ScriptedLlm, noticeRule, paymentRule, reading, terms } from './fixtures';

const succeeded = (outcome: ExtractionOutcome) => {
  if (outcome.status !== 'ok') throw new Error(`extraction failed: ${outcome.reason} ${outcome.detail}`);
  return outcome;
};

describe('extractContract: the first pass', () => {
  it('turns a verified reading into term facts, rules and dates the engine can use', async () => {
    const llm = new ScriptedLlm(() => reading());
    const out = succeeded(await extractContract(CONTRACT, llm));

    expect(out.model).toBe('scripted-model');
    expect(out.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.effectiveDate).toMatchObject({ status: 'ready', value: '2025-03-01' });
    expect(out.term).toMatchObject({ status: 'ready', value: { kind: 'fixed_length', length: { count: 2, unit: 'year' } } });
    expect(out.renewal).toMatchObject({ status: 'ready', value: { automatic: true, length: { count: 1, unit: 'year' } } });
    expect(out.contractTerms).toEqual({
      effectiveDate: '2025-03-01',
      initialTerm: { count: 2, unit: 'year' },
      initialTermEnd: null,
      renewalTerm: { count: 1, unit: 'year' },
    });

    expect(out.obligations.map((o) => [o.rule.kind, o.status])).toEqual([
      ['renewal_notice', 'ready'],
      ['payment', 'ready'],
    ]);
    // The model said page 7; the quote is on page 2, and the page shown is the one code found.
    expect(out.obligations[0]?.location.page).toBe(2);
    expect(out.grounding).toEqual({ quotesReturned: 5, quotesVerified: 5 });
    expect(out.calls).toBe(1);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 10 });

    // The whole chain: model rule + verified terms -> date engine.
    const notice = out.obligations[0];
    if (!notice) throw new Error('no notice obligation');
    const resolution = resolveRule(notice.rule, { terms: out.contractTerms, termIndex: 0 });
    expect(resolution.status === 'resolved' ? resolution.occurrences[0]?.date : resolution.status).toBe('2026-11-30');
  });

  it('sends the contract with page markers and forces the one tool', async () => {
    const llm = new ScriptedLlm(() => reading());
    await extractContract(CONTRACT, llm);
    const [request] = llm.requests;
    expect(request?.tool.name).toBe('record_contract');
    expect(request?.prompt).toContain('<page number="2">');
    expect(request?.prompt).toContain(QUOTES.payment);
    expect(request?.system).toMatch(/never calculate/i);
    expect(Object.keys((request?.tool.parameters as { properties?: object }).properties ?? {})).toEqual([
      'effectiveDate',
      'term',
      'renewal',
      'obligations',
    ]);
  });

  it('drops an obligation whose quote is not in the contract', async () => {
    const invented = paymentRule({ quote: 'Customer shall pay each invoice within forty-five (45) days.' });
    const llm = new ScriptedLlm(() => reading({ obligations: [noticeRule(), invented] }));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.obligations).toHaveLength(1);
    expect(out.rejected).toEqual([expect.objectContaining({ item: 'obligation', index: 1, reason: 'not_found' })]);
    expect(out.grounding).toEqual({ quotesReturned: 5, quotesVerified: 4 });
  });

  it('rejects a stated date that is not inside its own quote', async () => {
    const effectiveDate = { dateText: 'April 1, 2025', event: null, quote: QUOTES.effective, page: 1, confidence: 'high' };
    const llm = new ScriptedLlm(() => reading(terms({ effectiveDate })));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.effectiveDate).toBeNull();
    expect(out.contractTerms.effectiveDate).toBeNull();
    expect(out.rejected).toEqual([expect.objectContaining({ item: 'effectiveDate', reason: 'date_not_in_quote' })]);
  });

  it('holds back a written date that code cannot read with certainty', async () => {
    const doc = { pages: [{ page: 1, text: 'This Agreement is effective as of 03/04/2025 and continues for two (2) years.' }] };
    const effectiveDate = { dateText: '03/04/2025', event: null, quote: 'This Agreement is effective as of 03/04/2025', page: null, confidence: 'high' };
    const llm = new ScriptedLlm(() => ({ effectiveDate, term: null, renewal: null, obligations: [] }));
    const out = succeeded(await extractContract(doc, llm));
    expect(out.effectiveDate).toMatchObject({ status: 'needs_review', value: null, review: [{ reason: 'date_unreadable' }] });
    expect(out.contractTerms.effectiveDate).toBeNull();
    // A site that knows its contracts are month-first can say so once.
    const us = succeeded(await extractContract(doc, new ScriptedLlm(() => ({ effectiveDate, term: null, renewal: null, obligations: [] })), { numericDateOrder: 'month_first' }));
    expect(us.effectiveDate).toMatchObject({ status: 'ready', value: '2025-03-04' });
  });

  it('holds back an effective date that is an event rather than a date', async () => {
    const doc = { pages: [{ page: 1, text: 'This Agreement takes effect on the date of the last signature below.' }] };
    const effectiveDate = { dateText: null, event: 'date of the last signature', quote: 'This Agreement takes effect on the date of the last signature below.', page: null, confidence: 'high' };
    const llm = new ScriptedLlm(() => ({ effectiveDate, term: null, renewal: null, obligations: [] }));
    const out = succeeded(await extractContract(doc, llm));
    expect(out.effectiveDate).toMatchObject({ status: 'needs_review', value: null, review: [{ reason: 'needs_event_date' }] });
  });

  it('sends a rejected answer back once with the problems, then accepts the repair', async () => {
    const bad = reading({ obligations: [noticeRule({ recurrence: { every: { count: 1, unit: 'year' }, basis: 'contract' } }), paymentRule()] });
    const llm = new ScriptedLlm((_req, n) => (n === 0 ? bad : reading()));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(llm.calls('record_contract')).toHaveLength(2);
    const repair = llm.requests[1]?.repair;
    expect(repair?.previousArguments).toBe(JSON.stringify(bad));
    expect(repair?.problems.join(' ')).toMatch(/obligations\.0\.recurrence.*cannot recur/);
    expect(out.repaired).toBe(true);
    expect(out.obligations).toHaveLength(2);
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(out.attempts).toEqual([
      { tidied: { filledNulls: 0, unwrapped: 0 }, problems: ['obligations.0.recurrence: custom'] },
      { tidied: { filledNulls: 0, unwrapped: 0 }, problems: [] },
    ]);
  });

  it('keeps the valid obligations when one is still invalid after the repair', async () => {
    const withDate = reading({ obligations: [noticeRule(), paymentRule({ dueDate: '2025-04-30' })] });
    const llm = new ScriptedLlm(() => withDate);
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.obligations.map((o) => o.rule.kind)).toEqual(['renewal_notice']);
    expect(out.rejected).toEqual([expect.objectContaining({ item: 'obligation', index: 1, reason: 'schema' })]);
  });

  it('keeps items whose empty fields the model left out, without a repair', async () => {
    const drop = (value: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
    const full = reading();
    const sparse = {
      effectiveDate: drop(full.effectiveDate, 'event'),
      term: drop(full.term, 'endDateText'),
      renewal: full.renewal,
      obligations: [drop(noticeRule(), 'anchorDescription', 'recurrence', 'page'), drop(paymentRule(), 'recurrence')],
    };
    const llm = new ScriptedLlm(() => sparse);
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.calls).toBe(1);
    expect(out.rejected).toEqual([]);
    expect(out.effectiveDate).toMatchObject({ status: 'ready', value: '2025-03-01' });
    expect(out.term).toMatchObject({ status: 'ready' });
    expect(out.obligations.map((o) => [o.rule.kind, o.status])).toEqual([
      ['renewal_notice', 'ready'],
      ['payment', 'ready'],
    ]);
    expect(out.tidied).toEqual({ filledNulls: 6, unwrapped: 0 });
  });

  it('reads nested values the model sent as JSON text, without a repair', async () => {
    const full = reading();
    const llm = new ScriptedLlm(() => ({ ...full, effectiveDate: JSON.stringify(full.effectiveDate), obligations: JSON.stringify(full.obligations) }));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.calls).toBe(1);
    expect(out.effectiveDate).toMatchObject({ status: 'ready', value: '2025-03-01' });
    expect(out.obligations).toHaveLength(2);
    expect(out.tidied).toEqual({ filledNulls: 0, unwrapped: 2 });
  });

  it('records why each item was refused in field names only, never contract text', async () => {
    const bad = reading({ obligations: [noticeRule(), paymentRule({ offset: { count: 'thirty', unit: 'day', direction: 'after' } })] });
    const out = succeeded(await extractContract(CONTRACT, new ScriptedLlm(() => bad)));
    expect(out.rejected).toEqual([
      expect.objectContaining({ item: 'obligation', index: 1, reason: 'schema', detail: 'obligations.1.offset.count: invalid_type expected number got string' }),
    ]);
  });

  it('says what made a failed answer unusable, in field names only', async () => {
    const llm = new ScriptedLlm(() => ({ ...reading(), obligations: 'none' }));
    const out = await extractContract(CONTRACT, llm);
    expect(out).toMatchObject({ status: 'failed', reason: 'invalid_output', problems: ['obligations: invalid_type expected array got string'] });
  });

  it('fails when the answer is still unusable after the repair', async () => {
    const llm = new ScriptedLlm(() => '{"effectiveDate": ');
    const out = await extractContract(CONTRACT, llm);
    expect(out).toMatchObject({ status: 'failed', reason: 'invalid_output', calls: 2 });
  });

  it('fails when the model does not call the tool', async () => {
    const out = await extractContract(CONTRACT, new ScriptedLlm(() => undefined));
    expect(out).toMatchObject({ status: 'failed', reason: 'no_tool_call' });
  });

  it('refuses an oversized or empty document without calling the model', async () => {
    const llm = new ScriptedLlm(() => reading());
    expect(await extractContract(CONTRACT, llm, { maxDocumentChars: 100 })).toMatchObject({ status: 'failed', reason: 'too_long' });
    expect(await extractContract({ pages: [{ page: 1, text: '  \n ' }] }, llm)).toMatchObject({ status: 'failed', reason: 'empty_document' });
    expect(llm.requests).toHaveLength(0);
  });

  it('reports a model error as a failed run instead of throwing', async () => {
    const llm = new ScriptedLlm(() => new Error('upstream timeout'));
    expect(await extractContract(CONTRACT, llm)).toMatchObject({ status: 'failed', reason: 'llm_error' });
  });

  describe('a notice deadline counted back from the end of the term', () => {
    const CONVENIENCE =
      '14.2 Each Party may also terminate the Agreement for convenience by providing written notice to the other Party at least sixty (60) calendar days prior to the effective date of such termination.';
    const EVERGREEN = 'It shall automatically continue until terminated by either party upon not less than thirty (30) days prior written notice to the other party.';
    const doc = { pages: [{ page: 1, text: `${CONVENIENCE}\n${EVERGREEN}` }] };
    const notice = (quote: string, over: Record<string, unknown> = {}) =>
      noticeRule({ quote, page: null, offset: { count: 60, unit: 'day', direction: 'before' }, ...over });
    const run = async (...obligations: unknown[]) =>
      succeeded(await extractContract(doc, new ScriptedLlm(() => ({ effectiveDate: null, term: null, renewal: null, obligations }))));

    it('goes to review when its clause never mentions the term, its expiry or renewal: it may be a right to terminate on notice', async () => {
      const out = await run(notice(CONVENIENCE));
      expect(out.obligations).toEqual([
        expect.objectContaining({ status: 'needs_review', review: [expect.objectContaining({ reason: 'notice_not_tied_to_term' })] }),
      ]);
    });

    it('is not re-read: a second reading of the same words cannot tell a termination right from a renewal deadline', async () => {
      const out = await run(notice(CONVENIENCE, { confidence: 'low' }));
      expect(out.calls).toBe(1);
      expect(out.secondPasses).toBe(0);
      expect(out.obligations[0]?.review.map((n) => n.reason)).toEqual(['notice_not_tied_to_term']);
    });

    it('does not make a real notice look like a conflicting clause', async () => {
      const out = await run(notice(CONVENIENCE), notice(EVERGREEN, { offset: { count: 30, unit: 'day', direction: 'before' } }));
      expect(out.calls).toBe(1);
      expect(out.obligations.map((o) => [o.status, o.review.map((n) => n.reason)])).toEqual([
        ['needs_review', ['notice_not_tied_to_term']],
        ['ready', []],
      ]);
    });

    it('stays ready when its clause names the term or an automatic continuation', async () => {
      const out = await run(notice(EVERGREEN, { offset: { count: 30, unit: 'day', direction: 'before' } }));
      expect(out.obligations.map((o) => o.status)).toEqual(['ready']);
    });

    it('leaves other anchors and other kinds alone', async () => {
      const fromEvent = notice(CONVENIENCE, { anchor: 'event', anchorDescription: 'the chosen termination date' });
      const payment = paymentRule({ quote: CONVENIENCE, anchor: 'term_end', page: null, offset: { count: 60, unit: 'day', direction: 'before' } });
      const out = await run(fromEvent, payment);
      expect(out.obligations.map((o) => o.status)).toEqual(['ready', 'ready']);
    });
  });

  it('drops exact duplicates of the same obligation', async () => {
    const llm = new ScriptedLlm(() => reading({ obligations: [noticeRule(), noticeRule({ summary: 'Same again.' }), paymentRule()] }));
    const out = succeeded(await extractContract(CONTRACT, llm));
    expect(out.obligations.map((o) => o.rule.kind)).toEqual(['renewal_notice', 'payment']);
  });
});

describe('namesTheTerm', () => {
  it('finds the term, its expiry, renewal, an anniversary or an automatic continuation', () => {
    for (const quote of [
      'at least ninety (90) days before the end of the then-current term.',
      'not less than 90 days prior to the expiration of the Initial Term',
      'unless either party gives notice of non-renewal at least 60 days in advance',
      'at least three months before the expiry date of the Agreement',
      'no later than 30 days before each anniversary of the Effective Date',
      'It shall automatically continue until terminated by either party upon thirty (30) days notice.',
      'unless notice is given before the end of any Extension Period',
      'The Terms of Service may be terminated on 30 days notice.',
    ]) {
      expect(namesTheTerm(quote), quote).toBe(true);
    }
  });

  it('does not take "terminate" or "termination" for the term', () => {
    for (const quote of [
      'Each Party may terminate the Agreement for convenience at least sixty (60) days prior to the effective date of such termination.',
      'Either party may terminate this Agreement by giving the other at least ninety (90) days written notice.',
      'By any of the PHL Parties providing one hundred and twenty (120) days prior written notice to the other Parties.',
      'Terminated agreements end on the termination date.',
    ]) {
      expect(namesTheTerm(quote), quote).toBe(false);
    }
  });
});
