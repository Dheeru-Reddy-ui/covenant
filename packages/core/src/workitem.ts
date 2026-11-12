import type { IsoDate } from './dates/civil';
import { type Schedule, describeTiming } from './schedule';
import type { ObligationKind, ObligationRule } from './schema';
import { normaliseWhitespace } from './verify';

/**
 * The child work item a reviewer's approval creates: a title, a due date, and a
 * description in Atlassian Document Format that cites the clause verbatim and
 * shows how the date was worked out.
 */

export const KIND_LABELS: Record<ObligationKind, string> = {
  renewal_notice: 'Renewal notice',
  payment: 'Payment',
  price_change: 'Price change',
  reporting_deliverable: 'Report or deliverable',
  audit_insurance: 'Audit or insurance',
  service_credit: 'Service credit',
};

export interface AdfNode {
  type: string;
  text?: string;
  marks?: Array<{ type: string }>;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export interface WorkItemInput {
  rule: ObligationRule;
  schedule: Schedule;
  /** Where code found the quote. `paginated` is false for Word files, which have no fixed pages. */
  location: { page: number; pageEnd: number; paginated: boolean };
  source: { fileName: string; parentKey: string };
}

export interface WorkItemDraft {
  summary: string;
  description: AdfDoc;
  dueDate: IsoDate | null;
}

/** Jira's limit on a summary. */
const MAX_SUMMARY = 255;

const text = (value: string, strong = false): AdfNode =>
  strong ? { type: 'text', text: value, marks: [{ type: 'strong' }] } : { type: 'text', text: value };

const paragraph = (...parts: Array<AdfNode | string>): AdfNode => ({
  type: 'paragraph',
  content: parts.map((p) => (typeof p === 'string' ? text(p) : p)).filter((n) => (n.text ?? '').length > 0),
});

const labelled = (label: string, value: string): AdfNode => paragraph(text(`${label}: `, true), value);

function oneLine(value: string, max: number): string {
  const flat = normaliseWhitespace(value);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const UNDATED_TEXT: Partial<Record<string, string>> = {
  needs_event_date: 'it runs from an event whose date Covenant does not know. Set the due date when the event happens.',
  needs_fiscal_year: 'it follows a fiscal year whose start month the contract does not give.',
  missing_effective_date: 'the effective date has not been confirmed in Covenant.',
  missing_initial_term: 'the length of the initial term has not been confirmed in Covenant.',
  conflicting_term_facts: 'the contract\'s term facts contradict each other.',
};

function dueLine(schedule: Schedule): AdfNode {
  switch (schedule.status) {
    case 'upcoming':
      return labelled('Due', schedule.due);
    case 'past':
      return labelled('Due', `${schedule.due} (already passed when this was created)`);
    case 'undated':
      return labelled('Due', `no fixed due date, because ${UNDATED_TEXT[schedule.reason] ?? 'Covenant could not work out a date without guessing.'}`);
  }
}

function clauseLine(input: WorkItemInput): AdfNode {
  const { page, pageEnd, paginated } = input.location;
  const where = !paginated ? 'Word file, no page numbers' : page === pageEnd ? `page ${page}` : `pages ${page} to ${pageEnd}`;
  return paragraph(text('Clause', true), ` (${where}) in ${input.source.fileName}, attached to ${input.source.parentKey}:`);
}

export function draftWorkItem(input: WorkItemInput): WorkItemDraft {
  const { rule, schedule } = input;
  const content: AdfNode[] = [
    labelled('Who', rule.responsibleParty),
    labelled('When', describeTiming(rule)),
    dueLine(schedule),
    clauseLine(input),
    { type: 'blockquote', content: [paragraph(normaliseWhitespace(rule.quote))] },
  ];

  if (schedule.status !== 'undated' && schedule.trace.length > 0) {
    content.push(paragraph(text('How the date was worked out', true)));
    content.push({
      type: 'bulletList',
      content: schedule.trace.map((step) => ({ type: 'listItem', content: [paragraph(step)] })),
    });
  }
  content.push(paragraph('Created by Covenant after a person reviewed it. The model read the clause; code worked out the date.'));

  return {
    summary: oneLine(`${KIND_LABELS[rule.kind]}: ${rule.summary}`, MAX_SUMMARY),
    description: { type: 'doc', version: 1, content },
    dueDate: schedule.status === 'undated' ? null : schedule.due,
  };
}

export interface DecisionItemInput {
  fileName: string;
  parentKey: string;
  deadline: IsoDate;
  daysLeft: number;
  termEnd: IsoDate | null;
  /** The notice rule in plain English, for example "90 days before the end of the current term". */
  timing: string;
  clause: { quote: string; page: number; pageEnd: number; paginated: boolean } | null;
}

/** The "Decision due" work item the daily check opens when a notice deadline comes inside the lead time. */
export function draftDecisionItem(input: DecisionItemInput): WorkItemDraft {
  const days = `${input.daysLeft} day${input.daysLeft === 1 ? '' : 's'}`;
  const content: AdfNode[] = [
    labelled('Notice deadline', `${input.deadline}, ${days} after this item was opened`),
    labelled('Rule', input.timing),
  ];
  if (input.termEnd !== null) content.push(labelled('Current term ends', input.termEnd));
  if (input.clause !== null) {
    const c = input.clause;
    const where = !c.paginated ? 'Word file, no page numbers' : c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
    content.push(paragraph(text('Clause', true), ` (${where}) in ${input.fileName}:`));
    content.push({ type: 'blockquote', content: [paragraph(normaliseWhitespace(c.quote))] });
  }
  content.push(
    paragraph(`Decide whether to renew, renegotiate or terminate, then record the decision in the Covenant panel on ${input.parentKey}.`),
    paragraph("Opened by Covenant's daily check. The model read the clause; code worked out the date."),
  );
  return {
    summary: oneLine(`Decision due: renew, renegotiate or terminate ${input.fileName} by ${input.deadline}`, MAX_SUMMARY),
    description: { type: 'doc', version: 1, content },
    dueDate: input.deadline,
  };
}

/** All the text in a document, paragraphs separated by newlines. For tests and previews. */
export function adfText(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  const children = (node.content ?? []).map(adfText);
  return node.type === 'paragraph' ? children.join('') : children.join('\n');
}
