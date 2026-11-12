import { describe, expect, it } from 'vitest';
import type { Schedule } from '../src/schedule';
import { type AdfNode, KIND_LABELS, type WorkItemInput, adfText, draftWorkItem } from '../src/workitem';
import { type ObligationRule, ObligationRuleSchema } from '../src/schema';
import { QUOTES, noticeRule, paymentRule } from './fixtures';

const notice: ObligationRule = ObligationRuleSchema.parse(noticeRule());
const payment: ObligationRule = ObligationRuleSchema.parse(paymentRule());

const upcoming: Schedule = {
  status: 'upcoming',
  due: '2026-11-30',
  later: [],
  termIndex: 0,
  trace: ['initial term: 2025-03-01 + 2 years = 2027-02-28', 'end of term 1: 2027-02-28', '90 days before: 2026-11-30'],
};

const input = (over: Partial<WorkItemInput> = {}): WorkItemInput => ({
  rule: notice,
  schedule: upcoming,
  location: { page: 2, pageEnd: 2, paginated: true },
  source: { fileName: 'northwind-msa.pdf', parentKey: 'MOBL-57' },
  ...over,
});

const walk = (node: AdfNode, visit: (n: AdfNode) => void): void => {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
};

describe('draftWorkItem', () => {
  it('titles the item with the kind and the model\'s plain summary', () => {
    expect(draftWorkItem(input()).summary).toBe('Renewal notice: Give written notice of non-renewal before the term ends.');
  });

  it('keeps the title within Jira\'s 255 characters and on one line', () => {
    const long = { ...notice, summary: `Line one\nline two ${'x'.repeat(400)}` };
    const { summary } = draftWorkItem(input({ rule: long }));
    expect(summary.length).toBeLessThanOrEqual(255);
    expect(summary).not.toMatch(/\n/);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('sets the due date from the schedule, including a date that has passed', () => {
    expect(draftWorkItem(input()).dueDate).toBe('2026-11-30');
    expect(draftWorkItem(input({ schedule: { status: 'past', due: '2026-03-31', termIndex: 0, trace: [] } })).dueDate).toBe('2026-03-31');
  });

  it('leaves the due date empty when there is no date, and says why instead of guessing', () => {
    const draft = draftWorkItem(
      input({ rule: payment, schedule: { status: 'undated', reason: 'needs_event_date', detail: 'this deadline runs from an event' } }),
    );
    expect(draft.dueDate).toBe(null);
    const text = adfText(draft.description);
    expect(text).toContain('30 days after the date of the invoice');
    expect(text).toMatch(/no fixed due date/i);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('cites the clause verbatim with its page, file and parent work item', () => {
    const text = adfText(draftWorkItem(input()).description);
    expect(text).toContain(QUOTES.notice);
    expect(text).toContain('page 2');
    expect(text).toContain('northwind-msa.pdf');
    expect(text).toContain('MOBL-57');
    expect(text).toContain('Either party');
    expect(text).toContain('90 days before the end of the current term');
  });

  it('puts the quote in a block quote, collapsing the PDF\'s line breaks', () => {
    const quote = 'unless either party gives\nthe other   written notice';
    const draft = draftWorkItem(input({ rule: { ...notice, quote } }));
    const blocks: AdfNode[] = [];
    walk(draft.description, (n) => {
      if (n.type === 'blockquote') blocks.push(n);
    });
    expect(blocks).toHaveLength(1);
    expect(adfText(blocks[0] as AdfNode)).toBe('unless either party gives the other written notice');
  });

  it('shows how the date was worked out', () => {
    const text = adfText(draftWorkItem(input()).description);
    for (const step of upcoming.trace) expect(text).toContain(step);
  });

  it('names a page range, and says a Word file has no page numbers', () => {
    expect(adfText(draftWorkItem(input({ location: { page: 3, pageEnd: 4, paginated: true } })).description)).toContain('pages 3 to 4');
    const word = adfText(draftWorkItem(input({ location: { page: 1, pageEnd: 1, paginated: false } })).description);
    expect(word).toMatch(/Word file/);
    expect(word).not.toContain('page 1');
  });

  it('builds a valid document: version 1 and no empty text nodes', () => {
    const draft = draftWorkItem(input({ schedule: { status: 'undated', reason: 'missing_effective_date', detail: 'x' } }));
    expect(draft.description).toMatchObject({ type: 'doc', version: 1 });
    walk(draft.description, (n) => {
      if (n.type === 'text') expect((n.text ?? '').length).toBeGreaterThan(0);
    });
  });

  it('has a label for every kind', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual(
      ['audit_insurance', 'payment', 'price_change', 'renewal_notice', 'reporting_deliverable', 'service_credit'].sort(),
    );
  });
});
