import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type SourceDocument, locateQuote, normaliseWhitespace, verifyQuote } from '../src/verify';

const doc = (...pages: string[]): SourceDocument => ({
  pages: pages.map((text, i) => ({ page: i + 1, text })),
});

const CLAUSE =
  'Either party may terminate this Agreement by giving written notice at least ninety (90) days before the end of the then-current term.';

describe('normaliseWhitespace', () => {
  it('collapses every run of whitespace to one space and trims', () => {
    expect(normaliseWhitespace('  a \n\n b\t\tc \r\n')).toBe('a b c');
  });

  it('treats non-breaking and other Unicode spaces as whitespace', () => {
    expect(normaliseWhitespace('ninety (90) days later')).toBe('ninety (90) days later');
  });

  it('changes nothing else: case, punctuation and quote marks stay', () => {
    expect(normaliseWhitespace('“Term” means—Ninety.')).toBe('“Term” means—Ninety.');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normaliseWhitespace(s);
        expect(normaliseWhitespace(once)).toBe(once);
      }),
    );
  });
});

describe('verifyQuote', () => {
  it('accepts a quote that appears verbatim', () => {
    const r = verifyQuote('written notice at least ninety (90) days before', doc(`1. Term.\n${CLAUSE}`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ pageStart: 1, pageEnd: 1 });
  });

  it('accepts a quote whose line breaks and spacing differ from the source', () => {
    const source = doc('Either party may terminate\nthis   Agreement by giving\twritten notice at least ninety (90) days');
    const r = verifyQuote('terminate this Agreement by giving written notice at least ninety (90) days', source);
    expect(r.ok).toBe(true);
  });

  it('rejects a quote with one word changed', () => {
    const r = verifyQuote('written notice at least sixty (60) days before', doc(CLAUSE));
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects a quote that differs only in case or punctuation', () => {
    expect(verifyQuote('Written Notice At Least Ninety (90) Days', doc(CLAUSE)).ok).toBe(false);
    expect(verifyQuote('written notice, at least ninety (90) days', doc(CLAUSE)).ok).toBe(false);
  });

  it('rejects a quote stitched together from two separate places', () => {
    const r = verifyQuote('Either party may terminate this Agreement before the end of the then-current term', doc(CLAUSE));
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an empty or whitespace-only quote', () => {
    expect(verifyQuote('', doc(CLAUSE))).toEqual({ ok: false, reason: 'empty' });
    expect(verifyQuote(' \n\t ', doc(CLAUSE))).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a quote too short to prove anything', () => {
    expect(verifyQuote('the end', doc(CLAUSE))).toEqual({ ok: false, reason: 'too_short' });
  });

  it('lets the caller set the minimum length', () => {
    expect(verifyQuote('the end', doc(CLAUSE), { minChars: 5 }).ok).toBe(true);
  });

  it('rejects everything against an empty document', () => {
    expect(verifyQuote('written notice at least ninety', doc())).toEqual({ ok: false, reason: 'not_found' });
    expect(verifyQuote('written notice at least ninety', doc('', '  '))).toEqual({ ok: false, reason: 'not_found' });
  });

  it('finds the page a quote is on', () => {
    const source = doc('Page one is about definitions only.', `Page two. ${CLAUSE}`, 'Page three has signatures.');
    const r = verifyQuote('giving written notice at least ninety (90) days', source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toEqual([expect.objectContaining({ pageStart: 2, pageEnd: 2 })]);
  });

  it('uses the page numbers it is given, not positions in the list', () => {
    const source: SourceDocument = { pages: [{ page: 7, text: 'cover' }, { page: 8, text: CLAUSE }] };
    const r = verifyQuote('written notice at least ninety (90) days', source);
    expect(r.ok && r.matches[0]?.pageStart).toBe(8);
  });

  it('matches a quote that runs across a page break', () => {
    const source = doc('…by giving written notice at least', 'ninety (90) days before the end of the then-current term.');
    const r = verifyQuote('written notice at least ninety (90) days before', source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
  });

  it('reports every place a repeated quote appears', () => {
    const source = doc(`A. ${CLAUSE}`, 'Nothing here.', `C. ${CLAUSE}`);
    const r = verifyQuote('written notice at least ninety (90) days', source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches.map((m) => m.pageStart)).toEqual([1, 3]);
  });

  it('returns offsets that cut the quote back out of the original page text', () => {
    const text = `1.  Term.\n\n${CLAUSE.replace(/ /g, '  ')}`;
    const quote = 'written notice at least ninety (90) days';
    const r = verifyQuote(quote, doc('first page', text));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.matches[0]!;
    expect(m.pageStart).toBe(2);
    expect(normaliseWhitespace(text.slice(m.startOffset, m.endOffset))).toBe(quote);
  });
});

describe('locateQuote', () => {
  const twice = doc(`A. ${CLAUSE}`, 'Nothing here.', `C. ${CLAUSE}`);
  const quote = 'written notice at least ninety (90) days';

  it('returns the page for a quote that appears once', () => {
    expect(locateQuote(quote, doc('x', CLAUSE))).toMatchObject({ status: 'verified', page: 2, ambiguous: false, occurrences: 1 });
  });

  it('ignores a wrong page hint when the quote appears once: code decides the page', () => {
    expect(locateQuote(quote, doc('x', CLAUSE), 9)).toMatchObject({ status: 'verified', page: 2, ambiguous: false });
  });

  it('uses the page hint to choose between repeats', () => {
    expect(locateQuote(quote, twice, 3)).toMatchObject({ status: 'verified', page: 3, ambiguous: false, occurrences: 2 });
  });

  it('marks the location ambiguous when repeats cannot be told apart', () => {
    expect(locateQuote(quote, twice)).toMatchObject({ status: 'verified', page: 1, ambiguous: true, occurrences: 2 });
    expect(locateQuote(quote, twice, 2)).toMatchObject({ status: 'verified', page: 1, ambiguous: true });
  });

  it('rejects a quote that is not in the document', () => {
    expect(locateQuote('this sentence is nowhere in the contract', twice)).toEqual({ status: 'rejected', reason: 'not_found' });
  });
});

describe('verifyQuote properties', () => {
  // Words drawn from a small lowercase alphabet, so an uppercase letter can never occur by chance.
  const wordArb = fc.string({ unit: fc.constantFrom('a', 'b', 'c', 'd', 'e'), minLength: 2, maxLength: 8 });
  const wsArb = fc
    .array(fc.constantFrom(' ', '\n', '\t', '\r\n', ' ', '  '), { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join(''));
  const pageArb = fc.array(wordArb, { minLength: 6, maxLength: 40 });

  it('any run of words from the document verifies, however its whitespace is rewritten', () => {
    fc.assert(
      fc.property(
        fc.array(pageArb, { minLength: 1, maxLength: 4 }),
        fc.array(wsArb, { minLength: 200, maxLength: 200 }),
        fc.array(wsArb, { minLength: 200, maxLength: 200 }),
        fc.nat(),
        fc.nat(),
        (pages, sourceWs, quoteWs, a, b) => {
          const source: SourceDocument = {
            pages: pages.map((words, i) => ({
              page: i + 1,
              text: words.map((w, j) => w + sourceWs[(i * 41 + j) % sourceWs.length]).join(''),
            })),
          };
          const all = pages.flat();
          const start = a % all.length;
          const length = 1 + (b % (all.length - start));
          const picked = all.slice(start, start + length);
          const quote = picked.map((w, j) => w + (j < picked.length - 1 ? quoteWs[j % quoteWs.length] : '')).join('');
          fc.pre(normaliseWhitespace(quote).length >= 12);

          const r = verifyQuote(quote, source);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          for (const m of r.matches) {
            expect(m.pageStart).toBeLessThanOrEqual(m.pageEnd);
            expect(m.pageStart).toBeGreaterThanOrEqual(1);
            expect(m.pageEnd).toBeLessThanOrEqual(pages.length);
          }
        },
      ),
    );
  });

  it('a quote containing a character the document lacks never verifies', () => {
    fc.assert(
      fc.property(pageArb, fc.nat(), (words, at) => {
        const text = words.join(' ');
        fc.pre(text.length >= 12);
        const i = at % text.length;
        fc.pre(text[i] !== ' ');
        const tampered = `${text.slice(0, i)}X${text.slice(i + 1)}`;
        expect(verifyQuote(tampered, { pages: [{ page: 1, text }] }).ok).toBe(false);
      }),
    );
  });

  it('single-page offsets always cut out text equal to the quote', () => {
    fc.assert(
      fc.property(pageArb, wsArb, fc.nat(), fc.nat(), (words, ws, a, b) => {
        const text = ws + words.join(ws) + ws;
        const start = a % words.length;
        const length = 1 + (b % (words.length - start));
        const quote = words.slice(start, start + length).join(' ');
        fc.pre(quote.length >= 12);
        const r = verifyQuote(quote, { pages: [{ page: 1, text }] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        for (const m of r.matches) {
          expect(normaliseWhitespace(text.slice(m.startOffset, m.endOffset))).toBe(quote);
        }
      }),
    );
  });
});
