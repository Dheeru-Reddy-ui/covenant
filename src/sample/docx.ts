import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { Section } from '../../samples/fictional/contract-text';

/** A fictional contract as a Word file. No Forge imports, so the check script builds exactly what the app attaches. */
export async function buildContractDocx(title: string, sections: readonly Section[]): Promise<Uint8Array> {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  for (const section of sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(section.heading)] }));
    for (const paragraph of section.paragraphs) children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
  }
  const doc = new Document({ title: `${title} (fictional sample for Covenant)`, sections: [{ children }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
