import { describe, expect, it } from 'vitest';
import {
  TOOL_DEFAULT_LIMIT,
  TOOL_MAX_LIMIT,
  type ToolItem,
  clauseLocation,
  parseContractRef,
  parseKinds,
  parseListObligationsInput,
  parseObligationRef,
  parseRecordDecisionInput,
  parseTimeZone,
  selectObligations,
} from '../src/tools';

// Rovo and MCP send the declared inputs plus their own keys (context, contextToken).
const envelope = { context: { cloudId: 'c', moduleKey: 'm' }, contextToken: 't' };

describe('parseKinds', () => {
  it('accepts kind ids, labels and everyday words, comma separated', () => {
    expect(parseKinds('renewal_notice')).toEqual({ ok: true, value: ['renewal_notice'] });
    expect(parseKinds('Renewal notice, payments')).toEqual({ ok: true, value: ['renewal_notice', 'payment'] });
    expect(parseKinds('notice deadline')).toEqual({ ok: true, value: ['renewal_notice'] });
    expect(parseKinds('insurance; SLA')).toEqual({ ok: true, value: ['audit_insurance', 'service_credit'] });
    expect(parseKinds('Report or deliverable')).toEqual({ ok: true, value: ['reporting_deliverable'] });
  });

  it('drops duplicates and keeps the first order', () => {
    expect(parseKinds('notice, renewal, payment, notice')).toEqual({ ok: true, value: ['renewal_notice', 'payment'] });
  });

  it('names the valid kinds when one is unknown, instead of guessing', () => {
    const result = parseKinds('notice, indemnity');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toContain('indemnity');
      expect(result.problems[0]).toContain('renewal_notice');
    }
  });
});

describe('parseListObligationsInput', () => {
  it('defaults to every open obligation, 25 at a time, ignoring envelope keys', () => {
    expect(parseListObligationsInput(envelope)).toEqual({
      ok: true,
      value: { withinDays: null, kinds: null, contract: null, party: null, status: 'open', limit: TOOL_DEFAULT_LIMIT },
    });
    expect(parseListObligationsInput(undefined)).toMatchObject({ ok: true });
  });

  it('reads every filter, tolerating numbers sent as text and blank strings', () => {
    const result = parseListObligationsInput({
      ...envelope,
      withinDays: '90',
      kind: 'notice',
      contract: '  Quillfeather  ',
      party: '',
      status: 'Needs review',
      limit: 10,
    });
    expect(result).toEqual({
      ok: true,
      value: { withinDays: 90, kinds: ['renewal_notice'], contract: 'Quillfeather', party: null, status: 'needs_review', limit: 10 },
    });
  });

  it('accepts "all" as open and "approved"', () => {
    expect(parseListObligationsInput({ status: 'all' })).toMatchObject({ ok: true, value: { status: 'open' } });
    expect(parseListObligationsInput({ status: 'APPROVED' })).toMatchObject({ ok: true, value: { status: 'approved' } });
  });

  it('refuses out-of-range or malformed numbers with the allowed range', () => {
    for (const withinDays of [0, -5, 731, 2.5, 'soon']) {
      const result = parseListObligationsInput({ withinDays });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(' ')).toContain('withinDays');
    }
    const limit = parseListObligationsInput({ limit: TOOL_MAX_LIMIT + 1 });
    expect(limit.ok).toBe(false);
    if (!limit.ok) expect(limit.problems.join(' ')).toContain(String(TOOL_MAX_LIMIT));
  });

  it('refuses an unknown status and collects every problem at once', () => {
    const result = parseListObligationsInput({ status: 'late', kind: 'indemnity', limit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(3);
  });
});

type Row = ToolItem & { id: string };

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  kind: 'payment',
  due: '2026-12-01',
  scheduleStatus: 'upcoming',
  hasOwner: true,
  decision: 'approved',
  party: 'Customer',
  contractNames: ['MOBL-63', 'Quillfeather master services agreement', 'tallowmere-quillfeather-msa.pdf'],
  ...over,
});

const ctx = { today: '2026-11-12', noticeLeadDays: 60 };
const query = (over: Partial<Parameters<typeof selectObligations>[1]> = {}) => ({
  withinDays: null,
  kinds: null,
  contract: null,
  party: null,
  status: 'open' as const,
  limit: 25,
  ...over,
});
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('selectObligations', () => {
  const items = [
    row('notice-20', { kind: 'renewal_notice', due: '2026-12-02' }),
    row('notice-85', { kind: 'renewal_notice', due: '2027-02-05', decision: 'pending', contractNames: ['MOBL-69', 'Corvane hosting'] }),
    row('notice-120', { kind: 'renewal_notice', due: '2027-03-12' }),
    row('pay-overdue', { due: '2026-11-01' }),
    row('report-undated', { kind: 'reporting_deliverable', due: null, scheduleStatus: 'undated', party: 'Supplier' }),
    row('credit-rejected', { kind: 'service_credit', decision: 'rejected' }),
  ];

  it('answers "notice deadlines in the next 90 days" in date order', () => {
    const result = selectObligations(items, query({ withinDays: 90, kinds: ['renewal_notice'] }), ctx);
    expect(ids(result.rows)).toEqual(['notice-20', 'notice-85']);
    expect(result.rows[0]).toMatchObject({ daysLeft: 20, flags: { insideNoticeWindow: true, overdue: false } });
    expect(result.rows[1]).toMatchObject({ daysLeft: 85, flags: { insideNoticeWindow: false } });
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('without a window shows overdue and undated items too, but never rejected ones', () => {
    expect(ids(selectObligations(items, query(), ctx).rows)).toEqual(['pay-overdue', 'notice-20', 'notice-85', 'notice-120', 'report-undated']);
  });

  it('matches the contract by work item key, title or file name, ignoring case', () => {
    expect(ids(selectObligations(items, query({ contract: 'corvane' }), ctx).rows)).toEqual(['notice-85']);
    expect(ids(selectObligations(items, query({ contract: 'mobl-69' }), ctx).rows)).toEqual(['notice-85']);
    expect(selectObligations(items, query({ contract: 'brightwell' }), ctx).total).toBe(0);
  });

  it('matches the responsible party', () => {
    expect(ids(selectObligations(items, query({ party: 'supp' }), ctx).rows)).toEqual(['report-undated']);
  });

  it('filters by review status', () => {
    expect(ids(selectObligations(items, query({ status: 'needs_review' }), ctx).rows)).toEqual(['notice-85']);
    const edited = [row('e', { decision: 'edited' }), row('a', { decision: 'approving' })];
    expect(ids(selectObligations(edited, query({ status: 'needs_review' }), ctx).rows)).toEqual(['e']);
    expect(ids(selectObligations(edited, query({ status: 'approved' }), ctx).rows)).toEqual(['a']);
  });

  it('caps the rows and says how many matched', () => {
    const result = selectObligations(items, query({ limit: 2 }), ctx);
    expect(ids(result.rows)).toEqual(['pay-overdue', 'notice-20']);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });
});

describe('parseTimeZone', () => {
  it('reads an IANA zone name, or nothing', () => {
    expect(parseTimeZone({ ...envelope, timeZone: ' Asia/Kolkata ' })).toEqual({ ok: true, value: 'Asia/Kolkata' });
    expect(parseTimeZone({ timeZone: 'America/Argentina/Buenos_Aires' })).toEqual({ ok: true, value: 'America/Argentina/Buenos_Aires' });
    expect(parseTimeZone({ timeZone: 'UTC' })).toEqual({ ok: true, value: 'UTC' });
    expect(parseTimeZone({ timeZone: 'Etc/GMT+5' })).toEqual({ ok: true, value: 'Etc/GMT+5' });
    expect(parseTimeZone({})).toEqual({ ok: true, value: null });
    expect(parseTimeZone({ timeZone: '' })).toEqual({ ok: true, value: null });
  });

  it('refuses offsets and free text, which are not zones', () => {
    for (const timeZone of ['+05:30', 'IST in India', 'Asia/Kolkata; drop', 42]) {
      const result = parseTimeZone({ timeZone });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems[0]).toContain('timeZone');
    }
  });
});

describe('parseContractRef', () => {
  it('takes a work item key in any case, or a browse link', () => {
    expect(parseContractRef({ ...envelope, contract: ' mobl-63 ' })).toEqual({ ok: true, value: { issueKey: 'MOBL-63', contractId: null } });
    expect(parseContractRef({ contract: 'https://example.atlassian.net/browse/MOBL-63?focusedCommentId=1' })).toEqual({
      ok: true,
      value: { issueKey: 'MOBL-63', contractId: null },
    });
    expect(parseContractRef({ contract: 'MOBL-63', contractId: 'abc-123' })).toEqual({ ok: true, value: { issueKey: 'MOBL-63', contractId: 'abc-123' } });
  });

  it('refuses a missing or malformed key and says what it expects', () => {
    for (const raw of [{}, { contract: '' }, { contract: 'Quillfeather' }, { contract: 63 }]) {
      const result = parseContractRef(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems[0]).toContain('work item key');
    }
  });
});

describe('parseObligationRef', () => {
  it('needs an obligation id', () => {
    expect(parseObligationRef({ ...envelope, obligationId: ' 3f1c ' })).toEqual({ ok: true, value: { obligationId: '3f1c' } });
    expect(parseObligationRef({}).ok).toBe(false);
    expect(parseObligationRef({ obligationId: 'x'.repeat(65) }).ok).toBe(false);
  });
});

describe('parseRecordDecisionInput', () => {
  const base = { ...envelope, contract: 'MOBL-63', outcome: 'renew', rationale: 'Usage is up and the price holds for another year.' };

  it('is unconfirmed unless confirm is explicitly true', () => {
    for (const confirm of [undefined, false, 'false', 'yes', 1, null]) {
      const result = parseRecordDecisionInput({ ...base, confirm });
      expect(result).toMatchObject({ ok: true, value: { confirmed: false } });
    }
    expect(parseRecordDecisionInput({ ...base, confirm: true })).toMatchObject({ ok: true, value: { confirmed: true } });
    expect(parseRecordDecisionInput({ ...base, confirm: 'TRUE' })).toMatchObject({ ok: true, value: { confirmed: true } });
  });

  it('reads the contract, outcome and rationale', () => {
    expect(parseRecordDecisionInput({ ...base, outcome: ' Terminate ', confirm: true })).toEqual({
      ok: true,
      value: {
        issueKey: 'MOBL-63',
        contractId: null,
        outcome: 'terminate',
        rationale: 'Usage is up and the price holds for another year.',
        confirmed: true,
      },
    });
  });

  it('refuses an outcome it does not know rather than mapping it to one', () => {
    const result = parseRecordDecisionInput({ ...base, outcome: 'cancel', confirm: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toMatch(/renew, renegotiate, terminate/);
  });

  it('needs a real rationale and a contract', () => {
    const result = parseRecordDecisionInput({ ...envelope, outcome: 'renew', rationale: 'ok', confirm: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(' ')).toContain('rationale');
      expect(result.problems.join(' ')).toContain('work item key');
    }
  });
});

describe('clauseLocation', () => {
  it('names the page or page range, and says when a Word file has no pages', () => {
    expect(clauseLocation({ page: 4, pageEnd: 4, paginated: true })).toBe('page 4');
    expect(clauseLocation({ page: 4, pageEnd: 5, paginated: true })).toBe('pages 4 to 5');
    expect(clauseLocation({ page: 1, pageEnd: 1, paginated: false })).toBe('Word file (no page numbers)');
  });

  it('leads with the clause when code found one', () => {
    const section = { label: 'clause' as const, number: '1.2', heading: 'Term and renewal' };
    expect(clauseLocation({ page: 4, pageEnd: 4, paginated: true, section })).toBe('clause 1.2 (Term and renewal), page 4');
    expect(clauseLocation({ page: 4, pageEnd: 5, paginated: true, section })).toBe('clause 1.2 (Term and renewal), pages 4 to 5');
    expect(clauseLocation({ page: 1, pageEnd: 1, paginated: false, section })).toBe('clause 1.2 (Term and renewal), Word file');
    expect(clauseLocation({ page: 1, pageEnd: 1, paginated: false, section: null })).toBe('Word file (no page numbers)');
  });
});
