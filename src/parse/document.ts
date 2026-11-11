import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
// unpdf's bundled, dependency-free PDF.js build. Its main entry is not used: it calls
// import.meta.resolve('pdfjs-dist/...'), which Forge's bundler cannot resolve.
import { getDocument } from 'unpdf/pdfjs';
import { type SourceDocument, normaliseWhitespace } from '../../packages/core/src';

/**
 * Turns attachment bytes into page text. No Forge imports, so the same code
 * runs in a Forge function, in a local script and in the eval harness.
 * It never logs: callers get counts and hashes, not text.
 */

export type DocumentKind = 'pdf' | 'docx';

export interface ParsedDocument {
  kind: DocumentKind;
  /** False for DOCX: a Word file has no fixed pages, so everything is reported as page 1. */
  paginated: boolean;
  source: SourceDocument;
}

export class UnsupportedDocumentError extends Error {
  override name = 'UnsupportedDocumentError';
}

const startsWith = (bytes: Uint8Array, signature: number[]): boolean => signature.every((byte, i) => bytes[i] === byte);

/** Decide the file type from its first bytes, not from its name or the MIME type Jira reports. */
export function sniffKind(bytes: Uint8Array): DocumentKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'docx'; // a zip container; mammoth rejects non-Word zips
  return null;
}

export async function parseDocument(bytes: Uint8Array): Promise<ParsedDocument> {
  const kind = sniffKind(bytes);
  if (kind === null) throw new UnsupportedDocumentError('file is neither a PDF nor a DOCX');

  if (kind === 'pdf') {
    return { kind, paginated: true, source: { pages: await pdfPages(bytes) } };
  }

  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return { kind, paginated: false, source: { pages: [{ page: 1, text: value }] } };
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** One entry per PDF page, in order. Text items are joined as PDF.js reports them, with a newline where a line ends. */
async function pdfPages(bytes: Uint8Array): Promise<SourceDocument['pages']> {
  // PDF.js takes ownership of the array it is given, so hand it a copy.
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages: SourceDocument['pages'] = [];
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = (content.items as TextItemLike[])
        .filter((item) => typeof item.str === 'string')
        .map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ''}`)
        .join('');
      pages.push({ page, text });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export interface DocumentFingerprint {
  kind: DocumentKind;
  paginated: boolean;
  byteLength: number;
  bytesSha256: string;
  pages: number;
  /** Characters per page after whitespace normalisation. A scanned PDF shows up as all zeros. */
  charsPerPage: number[];
  totalChars: number;
  /** Hash of the whitespace-normalised text of all pages. Equal hashes mean equal text. */
  textSha256: string;
}

/** Counts and hashes that identify a parsed document without revealing any of its text. */
export function fingerprint(bytes: Uint8Array, parsed: ParsedDocument): DocumentFingerprint {
  const normalised = parsed.source.pages.map((p) => normaliseWhitespace(p.text));
  return {
    kind: parsed.kind,
    paginated: parsed.paginated,
    byteLength: bytes.byteLength,
    bytesSha256: sha256Hex(bytes),
    pages: normalised.length,
    charsPerPage: normalised.map((t) => t.length),
    totalChars: normalised.reduce((sum, t) => sum + t.length, 0),
    textSha256: sha256Hex(normalised.join('\n')),
  };
}
