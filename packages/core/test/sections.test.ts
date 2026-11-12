import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeSection, sectionAt } from '../src/sections';
import { verifyQuote } from '../src/verify';
import type { SourceDocument } from '../src/verify';
import { CONTRACT, QUOTES } from './fixtures';

/** Where the verifier finds `quote`, as the extraction pipeline stores it. */
function at(doc: SourceDocument, quote: string) {
  const found = verifyQuote(quote, doc);
  if (!found.ok) throw new Error(`fixture quote not found: ${quote}`);
  const match = found.matches[0];
  if (match === undefined) throw new Error('no match');
  return { pageStart: match.pageStart, startOffset: match.startOffset };
}

// A Word file as mammoth reads it: one page, paragraphs separated by blank lines.
const WORD: SourceDocument = {
  pages: [
    {
      page: 1,
      text: [
        'MASTER SERVICES AGREEMENT',
        'Parties',
        'This Master Services Agreement (the "Agreement") is made between Tallowmere Freight Ltd ("Customer") and Quillfeather Systems BV ("Supplier").',
        '1. Term and renewal',
        '1.1 This Agreement commences on 3 March 2025 (the "Effective Date") and continues for an initial term of two (2) years.',
        '1.2 This Agreement renews automatically for successive periods of one (1) year unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
        '2. Fees and payment',
        '2.1 Supplier shall invoice the Fees monthly in advance.',
        '2.2 Customer shall pay each undisputed invoice within thirty (30) days after the date of the invoice.',
      ].join('\n\n'),
    },
  ],
};

describe('sectionAt', () => {
  it('finds the numbered clause a quote sits in, and its section heading, in a Word file', () => {
    const notice = 'unless either party gives the other written notice of non-renewal';
    expect(sectionAt(WORD, at(WORD, notice))).toEqual({ label: 'clause', number: '1.2', heading: 'Term and renewal' });
    expect(sectionAt(WORD, at(WORD, 'Customer shall pay each undisputed invoice'))).toEqual({
      label: 'clause',
      number: '2.2',
      heading: 'Fees and payment',
    });
  });

  it('reads a title written into the clause itself', () => {
    expect(sectionAt(CONTRACT, at(CONTRACT, QUOTES.notice))).toEqual({ label: 'clause', number: '2.2', heading: 'Renewal' });
    expect(sectionAt(CONTRACT, at(CONTRACT, QUOTES.notice60))).toEqual({ label: 'clause', number: '9.4', heading: 'Non-renewal by Customer' });
    expect(sectionAt(CONTRACT, at(CONTRACT, QUOTES.term))).toEqual({ label: 'clause', number: '2.1', heading: 'Term' });
  });

  it('returns null where no clause number governs the quote', () => {
    expect(sectionAt(WORD, at(WORD, 'is made between Tallowmere Freight Ltd'))).toBeNull();
    expect(sectionAt(CONTRACT, at(CONTRACT, QUOTES.effective))).toBeNull();
  });

  it('walks back over wrapped PDF lines without mistaking numbers in the text for clause numbers', () => {
    const pdf: SourceDocument = {
      pages: [
        {
          page: 3,
          text: [
            '12. Termination',
            '12.1 Either party may terminate this Agreement by giving the',
            'other party not less than',
            '30 days written notice if the other party commits a material',
            '2027. The notice must state the breach in reasonable detail.',
          ].join('\n'),
        },
      ],
    };
    expect(sectionAt(pdf, at(pdf, 'notice must state the breach'))).toEqual({ label: 'clause', number: '12.1', heading: 'Termination' });
  });

  it('continues onto the previous page when a clause runs across a page break', () => {
    const pdf: SourceDocument = {
      pages: [
        { page: 4, text: '7. Insurance\n7.2 Supplier shall deliver to Customer a certificate evidencing the' },
        { page: 5, text: 'insurance required by this clause within thirty (30) days after each anniversary.\nPage 5 of 9' },
      ],
    };
    expect(sectionAt(pdf, at(pdf, 'insurance required by this clause'))).toEqual({ label: 'clause', number: '7.2', heading: 'Insurance' });
  });

  it('understands Section, Clause and Article numbering', () => {
    const doc: SourceDocument = {
      pages: [
        {
          page: 1,
          text: [
            'Section 5 - Term',
            'The initial term is three years from the Effective Date.',
            'Article IV. Payment',
            'Fees are due within forty-five days of invoice.',
            'Clause 9.3: Notices',
            'Notice of non-renewal must be given in writing.',
          ].join('\n'),
        },
      ],
    };
    expect(sectionAt(doc, at(doc, 'The initial term is three years'))).toEqual({ label: 'section', number: '5', heading: 'Term' });
    expect(sectionAt(doc, at(doc, 'Fees are due within forty-five days'))).toEqual({ label: 'article', number: 'IV', heading: 'Payment' });
    expect(sectionAt(doc, at(doc, 'Notice of non-renewal must be given'))).toEqual({ label: 'clause', number: '9.3', heading: 'Notices' });
  });

  it('gives up rather than reaching far back for a number', () => {
    const filler = Array.from({ length: 120 }, (_, i) => `plain line ${i} of the recitals without any numbering`).join('\n');
    const doc: SourceDocument = { pages: [{ page: 1, text: `1. Definitions\n${filler}\nthe quote we are looking for sits here.` }] };
    expect(sectionAt(doc, at(doc, 'the quote we are looking for'))).toBeNull();
  });

  it('ignores a position outside the document', () => {
    expect(sectionAt(WORD, { pageStart: 9, startOffset: 0 })).toBeNull();
  });

  it('never throws, and any answer names a number, for arbitrary text and positions', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 200 }), { minLength: 1, maxLength: 4 }), fc.nat(), fc.nat(), (texts, pageIndex, offset) => {
        const doc: SourceDocument = { pages: texts.map((text, i) => ({ page: i + 1, text })) };
        const page = doc.pages[pageIndex % doc.pages.length] as SourceDocument['pages'][number];
        const result = sectionAt(doc, { pageStart: page.page, startOffset: offset % (page.text.length + 1) });
        return result === null || result.number.length > 0;
      }),
    );
  });
});

describe('describeSection', () => {
  it('names the clause and its heading', () => {
    expect(describeSection({ label: 'clause', number: '1.2', heading: 'Term and renewal' })).toBe('clause 1.2 (Term and renewal)');
    expect(describeSection({ label: 'article', number: 'IV', heading: null })).toBe('article IV');
  });
});
