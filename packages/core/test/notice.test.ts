import { describe, expect, it } from 'vitest';
import { parseHolidayList } from '../src/dates/holidays';
import { DRAFT_BANNER, type NoticeDraftInput, draftAdf, draftNotice, draftText, earliestSendBy, sendByDates } from '../src/notice';
import { adfText } from '../src/workitem';

const holidays = (text: string) => {
  const r = parseHolidayList('Port Ellery', text);
  if (!r.ok) throw new Error('bad list');
  return r.value;
};

describe('sendByDates', () => {
  // The notice deadline is Wednesday 2 December 2026.
  const deadline = '2026-12-02';

  it('counts business days back from the deadline', () => {
    const [post] = sendByDates(deadline, [{ method: 'registered_post', deemedReceipt: { count: 3, unit: 'business_day' } }]);
    // Three business days before Wednesday is the Friday before.
    expect(post).toMatchObject({ label: 'By registered post', latest: '2026-11-27', rule: 'Counts as received 3 business days after sending.' });
    expect(post?.steps).toEqual([
      'Notice deadline: 2026-12-02',
      '3 business days before: 2026-11-27',
      'Business days are Monday to Friday. No holidays are listed for this contract, so none are skipped.',
    ]);
  });

  it('skips the contract\'s holidays and says which', () => {
    const [post] = sendByDates(deadline, [{ method: 'registered_post', deemedReceipt: { count: 3, unit: 'business_day' } }], holidays('2026-11-30 Founders\' Day'));
    expect(post?.latest).toBe('2026-11-26');
    expect(post?.steps.join(' ')).toContain("Skipped 2026-11-30 (Founders' Day).");
  });

  it('handles calendar days, hours, same-day receipt and a missing rule', () => {
    const dates = sendByDates(deadline, [
      { method: 'courier', deemedReceipt: { count: 2, unit: 'day' } },
      { method: 'email', deemedReceipt: { count: 24, unit: 'hour' } },
      { method: 'fax', deemedReceipt: { count: 25, unit: 'hour' } },
      { method: 'hand', deemedReceipt: { count: 0, unit: 'day' } },
      { method: 'post', deemedReceipt: null },
    ]);
    expect(dates.map((d) => d.latest)).toEqual(['2026-11-30', '2026-12-01', '2026-11-30', '2026-12-02', null]);
    expect(dates[4]?.rule).toBe('The contract does not say when notice sent this way counts as received.');
    expect(earliestSendBy(dates)).toBe('2026-11-30');
    expect(earliestSendBy([dates[4] as (typeof dates)[number]])).toBeNull();
  });

  it('gives nothing for a contract with no notice methods', () => {
    expect(sendByDates(deadline, [])).toEqual([]);
  });
});

describe('draftNotice', () => {
  const renewal = { quote: 'This Agreement renews automatically unless either party gives written notice of non-renewal at least ninety (90) days before the end of the then-current term.', where: 'clause 1.2 (Term and renewal), Word file' };
  const address = { party: 'Supplier', quote: 'Notices to Supplier must be sent to Quillfeather Systems BV, Kade 14, 3011 Port Ellery.', where: 'clause 5.1 (General), Word file' };
  const [sendBy] = sendByDates('2026-12-02', [{ method: 'registered_post', deemedReceipt: { count: 3, unit: 'business_day' } }]);
  if (!sendBy) throw new Error('no send-by');
  const input: NoticeDraftInput = {
    kind: 'non_renewal',
    contractTitle: 'Quillfeather Systems route planning MSA',
    fileName: 'sample-quillfeather-msa.docx',
    deadline: '2026-12-02',
    termEnd: '2027-03-02',
    sender: { label: 'Customer', name: 'Tallowmere Freight Ltd' },
    recipient: { label: 'Supplier', name: 'Quillfeather Systems BV' },
    renewalClause: renewal,
    addresses: [address],
    methods: [{ quote: 'A notice sent by registered post is deemed received three (3) business days after posting.', where: 'clause 5.2 (General), Word file', sendBy }],
  };

  it('is labelled a draft for legal review and quotes the renewal clause, address and method word for word', () => {
    const draft = draftNotice(input);
    expect(draft.title).toBe('Notice of non-renewal');
    expect(draft.lines[0]).toEqual({ style: 'banner', text: DRAFT_BANNER });
    const quotes = draft.lines.filter((l) => l.style === 'quote').map((l) => l.text);
    expect(quotes).toEqual([address.quote, renewal.quote, input.methods[0]?.quote]);
    const text = draftText(draft);
    expect(text).toContain('we do not wish the agreement to renew');
    expect(text).toContain('end at the close of the current term on 2027-03-02');
    expect(text).toContain('By registered post: send by 2026-11-27.');
    expect(text).toContain('The notice must be received by 2026-12-02.');
    expect(text).toContain('Tallowmere Freight Ltd');
  });

  it('leaves the address blank and says so when the contract has no notices clause', () => {
    const draft = draftNotice({ ...input, addresses: [], methods: [] });
    const text = draftText(draft);
    expect(text).toContain('The contract has no notices clause that Covenant could find, so the address is left blank.');
    expect(text).toContain('[address for notices]');
    expect(text).toContain('The contract does not say how notices must be given.');
  });

  it('uses visible blanks, never guesses, when it does not know who is who', () => {
    const draft = draftNotice({ ...input, sender: null, recipient: null, addresses: [address, { ...address, party: 'Customer' }], termEnd: null });
    const text = draftText(draft);
    expect(text).toContain('[your organisation, as named in the contract]');
    expect(text).toContain('[the other party, as named in the contract]');
    expect(text).toContain('[last day of the current term]');
    expect(text).toContain('Covenant does not know which party you are.');
  });

  it('writes a renewal notice for a contract that does not renew by itself', () => {
    expect(draftText(draftNotice({ ...input, kind: 'renewal' }))).toContain('we wish to renew the agreement for a further term');
  });

  it('renders as a Jira description with the banner in a warning panel', () => {
    const adf = draftAdf(draftNotice(input));
    expect(adf.content[0]).toMatchObject({ type: 'panel', attrs: { panelType: 'warning' } });
    expect(adfText(adf)).toContain(renewal.quote);
  });
});
