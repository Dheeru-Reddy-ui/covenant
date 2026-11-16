import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addBusinessDays, isBusinessDay } from '../src/dates/business';
import { compareDates } from '../src/dates/civil';
import { calendarOf, parseHolidayList } from '../src/dates/holidays';
import { DRAFT_BANNER, type NoticeDraftInput, draftAdf, draftNotice, draftText, earliestSendBy, sendByDates } from '../src/notice';
import { adfText } from '../src/workitem';
import { contractDateArb } from './arbitraries';

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

  it('counts back from the last business day when the deadline falls on a weekend', () => {
    // Saturday 5 December 2026. A deemed receipt counted in business days always lands on a business day,
    // so the latest it can land is Friday 4 December. Email sent on Friday counts as received on Monday: too late.
    const [post, email] = sendByDates('2026-12-05', [
      { method: 'registered_post', deemedReceipt: { count: 3, unit: 'business_day' } },
      { method: 'email', deemedReceipt: { count: 1, unit: 'business_day' } },
    ]);
    expect(post?.latest).toBe('2026-12-01');
    expect(email?.latest).toBe('2026-12-03');
    expect(email?.steps).toEqual([
      'Notice deadline: 2026-12-05',
      '2026-12-05 is not a business day, so the notice must count as received by 2026-12-04, the last business day before it',
      '1 business day before: 2026-12-03',
      'Business days are Monday to Friday. No holidays are listed for this contract, so none are skipped.',
    ]);
  });

  it('names the holiday when the deadline falls on one', () => {
    const [email] = sendByDates('2026-12-25', [{ method: 'email', deemedReceipt: { count: 1, unit: 'business_day' } }], holidays('2026-12-25 Christmas Day'));
    expect(email?.latest).toBe('2026-12-23');
    expect(email?.steps[1]).toBe('2026-12-25 is not a business day (Christmas Day), so the notice must count as received by 2026-12-24, the last business day before it');
  });

  it('leaves a calendar-day rule alone on a weekend deadline: those receipts can fall on any day', () => {
    const [courier] = sendByDates('2026-12-05', [{ method: 'courier', deemedReceipt: { count: 2, unit: 'day' } }]);
    expect(courier?.latest).toBe('2026-12-03');
  });

  it('always gives the latest day that still counts as received in time', () => {
    const holidayArb = fc.uniqueArray(contractDateArb, { maxLength: 12 }).map((dates) => ({ name: 'Generated', holidays: dates.map((date) => ({ date, label: '' })) }));
    fc.assert(
      fc.property(contractDateArb, fc.integer({ min: 1, max: 15 }), holidayArb, (due, n, list) => {
        const calendar = calendarOf(list);
        const [s] = sendByDates(due, [{ method: 'post', deemedReceipt: { count: n, unit: 'business_day' } }], list);
        const latest = s?.latest as string;
        // Sent on `latest`, it counts as received n business days later, on or before the deadline.
        expect(isBusinessDay(latest, calendar)).toBe(true);
        expect(compareDates(addBusinessDays(latest, n, calendar), due)).toBeLessThanOrEqual(0);
        // Sent on the next business day, it would be late.
        expect(compareDates(addBusinessDays(addBusinessDays(latest, 1, calendar), n, calendar), due)).toBeGreaterThan(0);
      }),
    );
  });
});

describe('draftNotice', () => {
  const renewal = {
    quote: 'This Agreement renews automatically unless either party gives written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
    where: 'clause 1.2 (Term and renewal), Word file',
    clause: 'clause 1.2 (Term and renewal)',
  };
  const address = { party: 'Supplier', quote: 'Notices to Supplier must be sent to Quillfeather Systems BV, Kade 14, 3011 Port Ellery.', where: 'clause 5.1 (General), Word file' };
  const [sendBy] = sendByDates('2026-12-02', [{ method: 'registered_post', deemedReceipt: { count: 3, unit: 'business_day' } }]);
  if (!sendBy) throw new Error('no send-by');
  const input: NoticeDraftInput = {
    kind: 'non_renewal',
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

  it('the letter itself names the agreement and the clause, never Jira keys, file types or pages', () => {
    const draft = draftNotice(input);
    const letter = draft.lines.filter((l) => l.style === 'text' || l.style === 'heading').map((l) => l.text);
    expect(letter).toContain('Subject: Notice of non-renewal of the agreement between Tallowmere Freight Ltd and Quillfeather Systems BV');
    expect(letter.join('\n')).toContain('Under clause 1.2 (Term and renewal), the agreement provides:');
    expect(letter.join('\n')).not.toMatch(/Word file|page \d/);
    // Without a numbered clause the letter quotes the provision without a location.
    const bare = draftNotice({ ...input, renewalClause: { quote: renewal.quote, where: 'Word file (no page numbers)', clause: null } });
    expect(draftText(bare)).toContain('(sample-quillfeather-msa.docx). The agreement provides:');
    expect(draftText(bare)).not.toContain('Under Word file');
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
