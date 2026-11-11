// Builds the fictional sample contract as a PDF and a DOCX, then checks them the way
// Covenant will: parse, find each key clause verbatim, and confirm the page.
//
//   npm run samples
//
// Use the two files it writes for spike S1 (attach both to a Jira work item).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts } from 'pdf-lib';
import { locateQuote } from '../packages/core/src';
import { CONTRACT_TITLE, KEY_CLAUSES, SECTIONS } from '../samples/fictional/contract-text';
import { fingerprint, parseDocument } from '../src/parse/document';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'fictional');
const PDF_PATH = join(OUT_DIR, 'tallowmere-quillfeather-msa.pdf');
const DOCX_PATH = join(OUT_DIR, 'tallowmere-quillfeather-msa.docx');

const PAGE = { width: 595.28, height: 841.89, margin: 72 }; // A4, one-inch margins
const BODY = { size: 11, leading: 15.5, gap: 9 };
const HEADING = { size: 13, leading: 20, gap: 6 };

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line !== '') {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

async function buildPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Fictional sample contract (Covenant test fixture)');
  // Fixed dates keep the file byte-identical between runs, so its hash is stable.
  pdf.setCreationDate(new Date('2026-11-11T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-11-11T00:00:00Z'));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const maxWidth = PAGE.width - PAGE.margin * 2;

  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.margin;
  };
  const write = (text: string, font: PDFFont, style: { size: number; leading: number; gap: number }) => {
    for (const line of wrap(text, font, style.size, maxWidth)) {
      if (y - style.leading < PAGE.margin) newPage();
      y -= style.leading;
      page.drawText(line, { x: PAGE.margin, y, size: style.size, font });
    }
    y -= style.gap;
  };

  write(CONTRACT_TITLE, bold, { size: 16, leading: 24, gap: 14 });
  for (const section of SECTIONS) {
    if (section.heading.startsWith('Schedule')) newPage();
    write(section.heading, bold, HEADING);
    for (const paragraph of section.paragraphs) write(paragraph, regular, BODY);
  }

  pdf.getPages().forEach((p, i, all) => {
    p.drawText(`Fictional sample for testing. Page ${i + 1} of ${all.length}`, { x: PAGE.margin, y: 40, size: 8, font: regular });
  });
  return pdf.save({ useObjectStreams: false });
}

async function buildDocx(): Promise<Uint8Array> {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(CONTRACT_TITLE)] })];
  for (const section of SECTIONS) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(section.heading)] }));
    for (const paragraph of section.paragraphs) children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
  }
  const doc = new Document({
    title: 'Fictional sample contract (Covenant test fixture)',
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

async function check(label: string, bytes: Uint8Array): Promise<boolean> {
  const parsed = await parseDocument(bytes);
  const print = fingerprint(bytes, parsed);
  console.log(`\n${label}: ${print.byteLength} bytes, ${print.pages} page(s), ${print.totalChars} characters`);
  console.log(`  bytesSha256 ${print.bytesSha256}`);
  console.log(`  textSha256  ${print.textSha256}`);

  let allFound = true;
  for (const [name, clause] of Object.entries(KEY_CLAUSES)) {
    const location = locateQuote(clause, parsed.source);
    const found = location.status === 'verified';
    allFound &&= found;
    const where = location.status === 'verified' ? `page ${location.page}${location.ambiguous ? ' (appears more than once)' : ''}` : location.reason;
    console.log(`  ${found ? 'found  ' : 'MISSING'} ${name.padEnd(13)} ${where}`);
  }
  return allFound;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const pdfBytes = await buildPdf();
  const docxBytes = await buildDocx();
  writeFileSync(PDF_PATH, pdfBytes);
  writeFileSync(DOCX_PATH, docxBytes);

  const pdfOk = await check('PDF ', pdfBytes);
  const docxOk = await check('DOCX', docxBytes);
  console.log(`\nwrote ${PDF_PATH}`);
  console.log(`wrote ${DOCX_PATH}`);
  if (!pdfOk || !docxOk) {
    console.error('\nA key clause was not found verbatim in the parsed text. The parser or the verifier needs attention.');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
