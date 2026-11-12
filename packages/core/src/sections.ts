import type { SourceDocument } from './verify';

/**
 * Which numbered clause a verified quote sits in, worked out by code from the
 * text around it. A Word file has no fixed pages, so this is often the only
 * way to say where a quote is; in a PDF it adds the clause to the page.
 *
 * It reads backwards from the quote to the nearest clause number ("1.2",
 * "12.", "Section 5", "Article IV") and then to its heading. Numbers inside
 * running text, such as "30 days" at the start of a wrapped PDF line, are not
 * clause numbers. If nothing qualifies nearby, the answer is null: a missing
 * locator is better than a wrong one.
 */

export interface ClauseSection {
  label: 'clause' | 'section' | 'article';
  /** As the contract writes it: "1.2", "12", "IV". */
  number: string;
  heading: string | null;
}

const MAX_LOOKBACK_LINES = 80;
const MAX_HEADING_CHARS = 60;
const MAX_HEADING_WORDS = 6;

// "1.2 This", "12. Termination", "3.1.4 (a)". A bare "30 days" is not a clause number: it needs a dot.
const NUMBERED = /^\s*(\d{1,3}(?:\.\d{1,3})+|\d{1,3}(?=\.))\.?\s+(?=[A-Z"“'‘(])(.*)$/;
// "Section 5 - Term", "Article IV. Payment", "Clause 9.3: Notices", "SECTION 7 TERM".
const NAMED =
  /^\s*(Section|SECTION|Clause|CLAUSE|Article|ARTICLE)\s+(\d{1,3}(?:\.\d{1,3})*|[IVXLC]{1,7})\.?(?:\s*[:.\-–—]\s*|\s+(?=[A-Z"“'‘(])|\s*$)(.*)$/;
// "Renewal. This Agreement renews...": a short title ending in a full stop, then the clause text.
const INLINE_TITLE = /^([A-Z][A-Za-z'’\-/&, ]{1,58}[A-Za-z])\.\s+\S/;

// A heading does not end on a word that leaves the sentence hanging, as a wrapped line does.
const HANGING = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'by', 'for', 'in', 'on', 'with', 'may', 'shall', 'will', 'must', 'be', 'is', 'are', 'any', 'each', 'its', 'their', 'this', 'that', 'than', 'not']);

interface Numbered {
  label: ClauseSection['label'];
  number: string;
  rest: string;
}

function numbered(line: string): Numbered | null {
  const named = NAMED.exec(line);
  if (named) {
    const word = (named[1] ?? '').toLowerCase() as ClauseSection['label'];
    return { label: word, number: named[2] ?? '', rest: (named[3] ?? '').trim() };
  }
  const plain = NUMBERED.exec(line);
  if (plain) return { label: 'clause', number: plain[1] ?? '', rest: (plain[2] ?? '').trim() };
  return null;
}

const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[.:\s]+$/, '')
    .trim();

/** The rest of a numbered line, when that line is a heading on its own: short, no full stop, and not hanging. */
function headingOf(rest: string): string | null {
  const text = rest.trim();
  if (text === '' || text.length > MAX_HEADING_CHARS || /[.;,]$/.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length > MAX_HEADING_WORDS) return null;
  if (HANGING.has((words[words.length - 1] ?? '').toLowerCase())) return null;
  return tidy(text);
}

function inlineTitle(rest: string): string | null {
  const m = INLINE_TITLE.exec(rest);
  if (!m) return null;
  const title = m[1] ?? '';
  return title.split(/\s+/).length <= MAX_HEADING_WORDS ? tidy(title) : null;
}

/** The top-level part of a clause number: "12" for "12.1.3". Roman numerals stand alone. */
const topOf = (n: string): string => n.split('.')[0] ?? n;

export function sectionAt(doc: SourceDocument, at: { pageStart: number; startOffset: number }): ClauseSection | null {
  const pageIndex = doc.pages.findIndex((p) => p.page === at.pageStart);
  const page = doc.pages[pageIndex];
  if (page === undefined || at.startOffset < 0 || at.startOffset > page.text.length) return null;

  // Lines from the start of the quote's line backwards, onto the previous page if needed.
  const upToQuote = page.text.slice(0, at.startOffset);
  const lineStart = upToQuote.lastIndexOf('\n') + 1;
  const lineEnd = page.text.indexOf('\n', at.startOffset);
  const quoteLine = page.text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const before = page.text.slice(0, lineStart).split(/\r?\n/).reverse();
  const previous = pageIndex > 0 ? (doc.pages[pageIndex - 1]?.text ?? '').split(/\r?\n/).reverse() : [];
  const lines = [quoteLine, ...before, ...previous].filter((l) => l.trim() !== '').slice(0, MAX_LOOKBACK_LINES);

  for (let i = 0; i < lines.length; i += 1) {
    const found = numbered(lines[i] ?? '');
    if (found === null) continue;
    const own = inlineTitle(found.rest) ?? headingOf(found.rest);
    if (own !== null) return { label: found.label, number: found.number, heading: own };
    // A sub-clause takes the heading of its section, if that section's heading line is nearby.
    if (found.number.includes('.')) {
      const top = topOf(found.number);
      for (let j = i + 1; j < lines.length; j += 1) {
        const parent = numbered(lines[j] ?? '');
        if (parent === null || parent.number !== top) continue;
        return { label: found.label, number: found.number, heading: headingOf(parent.rest) };
      }
    }
    return { label: found.label, number: found.number, heading: null };
  }
  return null;
}

/** "clause 1.2 (Term and renewal)". */
export function describeSection(section: ClauseSection): string {
  return `${section.label} ${section.number}${section.heading ? ` (${section.heading})` : ''}`;
}
