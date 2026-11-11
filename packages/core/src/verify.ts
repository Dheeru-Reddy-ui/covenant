/**
 * The clause verifier. An obligation is only kept if its quote appears in the
 * source text, character for character, once whitespace is normalised.
 *
 * Whitespace is the only thing normalised. Case, punctuation, quote marks and
 * hyphens must match exactly: loosening any of them would let a paraphrase
 * pass as a quotation.
 */

export interface SourcePage {
  /** Page number as shown to a reader, starting at 1. */
  page: number;
  text: string;
}

export interface SourceDocument {
  pages: SourcePage[];
}

export interface QuoteMatch {
  pageStart: number;
  pageEnd: number;
  /** Index into the text of `pageStart` where the quote begins. */
  startOffset: number;
  /** Index into the text of `pageEnd` just past where the quote ends. */
  endOffset: number;
}

export type QuoteRejection = 'empty' | 'too_short' | 'not_found';

export type QuoteVerification = { ok: true; matches: QuoteMatch[] } | { ok: false; reason: QuoteRejection };

export interface VerifyOptions {
  /**
   * Shortest quote, in characters after normalisation, that counts as evidence.
   * A two-word quote would match almost any contract. Default 12.
   */
  minChars?: number;
}

export const DEFAULT_MIN_QUOTE_CHARS = 12;

const WHITESPACE = /\s/;
const WHITESPACE_RUN = /\s+/g;

/** Collapse every run of whitespace (including non-breaking and other Unicode spaces) to one space, and trim. */
export function normaliseWhitespace(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim();
}

interface Origin {
  pageIndex: number;
  offset: number;
}

interface NormalisedDocument {
  text: string;
  /** For each character of `text`, where it came from. A space maps to the first whitespace character of its run. */
  origins: Origin[];
}

function normaliseDocument(doc: SourceDocument): NormalisedDocument {
  const chars: string[] = [];
  const origins: Origin[] = [];
  let pendingSpace: Origin | null = null;

  doc.pages.forEach((page, pageIndex) => {
    const { text } = page;
    for (let offset = 0; offset < text.length; offset += 1) {
      const ch = text.charAt(offset);
      if (WHITESPACE.test(ch)) {
        if (pendingSpace === null && chars.length > 0) pendingSpace = { pageIndex, offset };
        continue;
      }
      if (pendingSpace !== null) {
        chars.push(' ');
        origins.push(pendingSpace);
        pendingSpace = null;
      }
      chars.push(ch);
      origins.push({ pageIndex, offset });
    }
    // A page break separates words just as a space does.
    if (pendingSpace === null && chars.length > 0) pendingSpace = { pageIndex, offset: text.length };
  });

  return { text: chars.join(''), origins };
}

/**
 * Check that `quote` appears verbatim in `doc` after whitespace normalisation,
 * and report every place it appears. A quote may run across a page break.
 */
export function verifyQuote(quote: string, doc: SourceDocument, options: VerifyOptions = {}): QuoteVerification {
  const minChars = options.minChars ?? DEFAULT_MIN_QUOTE_CHARS;
  const needle = normaliseWhitespace(quote);
  if (needle.length === 0) return { ok: false, reason: 'empty' };
  if (needle.length < minChars) return { ok: false, reason: 'too_short' };

  const haystack = normaliseDocument(doc);
  const matches: QuoteMatch[] = [];
  for (let at = haystack.text.indexOf(needle); at !== -1; at = haystack.text.indexOf(needle, at + 1)) {
    const first = haystack.origins[at];
    const last = haystack.origins[at + needle.length - 1];
    const firstPage = first && doc.pages[first.pageIndex];
    const lastPage = last && doc.pages[last.pageIndex];
    if (!first || !last || !firstPage || !lastPage) continue;
    matches.push({
      pageStart: firstPage.page,
      pageEnd: lastPage.page,
      startOffset: first.offset,
      endOffset: last.offset + 1,
    });
  }

  return matches.length > 0 ? { ok: true, matches } : { ok: false, reason: 'not_found' };
}

export type QuoteLocation =
  | {
      status: 'verified';
      /** The page the quote starts on. Derived from the document, never taken from the model. */
      page: number;
      pageEnd: number;
      /** True when the quote appears in more than one place and the hint could not single one out. */
      ambiguous: boolean;
      occurrences: number;
      match: QuoteMatch;
    }
  | { status: 'rejected'; reason: QuoteRejection };

/**
 * Verify a quote and settle which page it is on. The model's page number is
 * only ever a hint for choosing between repeats of the same text: a quote that
 * appears once gets the page the document says, whatever the model claimed.
 */
export function locateQuote(quote: string, doc: SourceDocument, pageHint?: number | null, options: VerifyOptions = {}): QuoteLocation {
  const result = verifyQuote(quote, doc, options);
  if (!result.ok) return { status: 'rejected', reason: result.reason };

  const { matches } = result;
  const first = matches[0];
  if (first === undefined) return { status: 'rejected', reason: 'not_found' };

  let chosen = first;
  let ambiguous = matches.length > 1;
  if (matches.length > 1 && pageHint !== undefined && pageHint !== null) {
    const onHintedPage = matches.filter((m) => m.pageStart <= pageHint && pageHint <= m.pageEnd);
    const only = onHintedPage[0];
    if (onHintedPage.length === 1 && only !== undefined) {
      chosen = only;
      ambiguous = false;
    }
  }

  return {
    status: 'verified',
    page: chosen.pageStart,
    pageEnd: chosen.pageEnd,
    ambiguous,
    occurrences: matches.length,
    match: chosen,
  };
}
