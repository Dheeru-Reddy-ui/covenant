import { addBusinessDays, rollToBusinessDay } from './dates/business';
import { type IsoDate, addDays, compareDates } from './dates/civil';
import { type HolidayList, WEEKENDS_ONLY, calendarOf, describeCalendar, holidayText, holidaysBetween } from './dates/holidays';
import type { NoticeMethod } from './details';
import type { AdfDoc, AdfNode } from './workitem';

/**
 * Giving notice: the latest day a notice can be sent by each method the
 * contract allows, and a drafted letter for a person and their lawyer to
 * check. The date engine does the counting; the letter quotes the contract and
 * leaves a visible blank wherever the contract is silent.
 */

export const METHOD_LABELS: Record<NoticeMethod, string> = {
  hand: 'By hand',
  post: 'By post',
  registered_post: 'By registered post',
  courier: 'By courier',
  email: 'By email',
  fax: 'By fax',
  other: 'By another method the contract allows',
};

export interface MethodRule {
  method: NoticeMethod;
  /** When notice sent this way counts as received, after sending. Null when the contract does not say. */
  deemedReceipt: { count: number; unit: 'hour' | 'day' | 'business_day' } | null;
}

export interface SendBy {
  method: NoticeMethod;
  label: string;
  /** The latest day to send so that the notice counts as received by the deadline. Null when the contract gives no receipt rule. */
  latest: IsoDate | null;
  /** The receipt rule in words. */
  rule: string;
  /** How the date was worked out, for "why this date". */
  steps: string[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The latest send date per method, in the order given. Counting back from the deadline, a notice sent on that day is received on or before it. */
export function sendByDates(deadline: IsoDate, methods: readonly MethodRule[], holidays: HolidayList = WEEKENDS_ONLY): SendBy[] {
  return methods.map((m): SendBy => {
    const label = METHOD_LABELS[m.method];
    const d = m.deemedReceipt;
    if (d === null) {
      return {
        method: m.method,
        label,
        latest: null,
        rule: 'The contract does not say when notice sent this way counts as received.',
        steps: ['No receipt rule in the contract, so Covenant gives no send-by date. Allow for delivery time and aim for the notice to arrive before the deadline.'],
      };
    }
    if (d.count === 0) {
      return { method: m.method, label, latest: deadline, rule: 'Counts as received when it is delivered or sent.', steps: [`Notice deadline: ${deadline}`, `Received on the day it is sent: ${deadline}`] };
    }
    if (d.unit === 'business_day') {
      // A receipt counted in business days always lands on a business day, so on a weekend or holiday
      // deadline the latest it can land is the business day before. Counting back from the deadline
      // itself would give a send date whose receipt falls after it.
      const calendar = calendarOf(holidays);
      const receivedBy = rollToBusinessDay(deadline, 'preceding', calendar);
      const latest = addBusinessDays(receivedBy, -d.count, calendar);
      const steps = [`Notice deadline: ${deadline}`];
      if (receivedBy !== deadline) {
        const holiday = holidays.holidays.find((h) => h.date === deadline);
        steps.push(
          `${deadline} is not a business day${holiday?.label ? ` (${holiday.label})` : ''}, so the notice must count as received by ${receivedBy}, the last business day before it`,
        );
      }
      steps.push(`${plural(d.count, 'business day')} before: ${latest}`, describeCalendar(holidays));
      const skipped = holidaysBetween(holidays, latest, receivedBy);
      if (skipped.length > 0) steps.push(`Skipped ${skipped.map(holidayText).join(', ')}.`);
      return { method: m.method, label, latest, rule: `Counts as received ${plural(d.count, 'business day')} after sending.`, steps };
    }
    // Hours round up to whole days: a notice needing 24 hours must go the day before.
    const days = d.unit === 'hour' ? Math.ceil(d.count / 24) : d.count;
    const latest = addDays(deadline, -days);
    const rule = d.unit === 'hour' ? `Counts as received ${plural(d.count, 'hour')} after sending.` : `Counts as received ${plural(d.count, 'day')} after sending.`;
    const steps = [`Notice deadline: ${deadline}`, `${plural(days, 'day')} before${d.unit === 'hour' ? ` (${plural(d.count, 'hour')}, rounded up to whole days)` : ''}: ${latest}`];
    return { method: m.method, label, latest, rule, steps };
  });
}

/** The earliest of the send-by dates: the day to act by whichever method is chosen. Null when no method has one. */
export function earliestSendBy(dates: readonly SendBy[]): IsoDate | null {
  let earliest: IsoDate | null = null;
  for (const d of dates) if (d.latest !== null && (earliest === null || compareDates(d.latest, earliest) < 0)) earliest = d.latest;
  return earliest;
}

export interface Cited {
  quote: string;
  /** Where the quote sits, such as "clause 9.2 (Notices), page 7". For the person sending. */
  where: string;
  /** The numbered clause alone, such as "clause 9.2 (Notices)": what the letter itself cites. Null when code found no clause number. */
  clause?: string | null;
}

export interface NoticeDraftInput {
  /** non_renewal: stop an automatic renewal or end the contract. renewal: exercise a renewal that does not happen by itself. */
  kind: 'non_renewal' | 'renewal';
  fileName: string;
  deadline: IsoDate;
  termEnd: IsoDate | null;
  /** The party giving notice and the party receiving it, when a person has said which one they are. */
  sender: { label: string; name: string | null } | null;
  recipient: { label: string; name: string | null } | null;
  renewalClause: Cited | null;
  /** The address for notices to the recipient, or every notice address when the recipient is not known. */
  addresses: Array<Cited & { party: string }>;
  methods: Array<Cited & { sendBy: SendBy }>;
}

export type DraftLine = { style: 'banner' | 'heading' | 'text' | 'quote' | 'note'; text: string };

export interface NoticeDraft {
  title: string;
  lines: DraftLine[];
}

export const DRAFT_BANNER = 'DRAFT FOR LEGAL REVIEW. Covenant wrote this from the contract. It has not been sent, and it is not legal advice.';

export function draftNotice(input: NoticeDraftInput): NoticeDraft {
  const nonRenewal = input.kind === 'non_renewal';
  const title = nonRenewal ? 'Notice of non-renewal' : 'Notice of renewal';
  const lines: DraftLine[] = [{ style: 'banner', text: DRAFT_BANNER }];
  const blank = (what: string) => `[${what}]`;

  const senderName = input.sender?.name ?? blank(input.sender ? `full name of ${input.sender.label}` : 'your organisation, as named in the contract');
  const recipientName = input.recipient?.name ?? blank(input.recipient ? `full name of ${input.recipient.label}` : 'the other party, as named in the contract');

  lines.push({ style: 'heading', text: 'To' });
  lines.push({ style: 'text', text: recipientName });
  if (input.addresses.length === 0) {
    lines.push({ style: 'note', text: 'The contract has no notices clause that Covenant could find, so the address is left blank. Check the contract and fill it in.' });
    lines.push({ style: 'text', text: blank('address for notices') });
  } else {
    for (const a of input.addresses) {
      lines.push({ style: 'note', text: `Address for notices to ${a.party}, from ${a.where}:` });
      lines.push({ style: 'quote', text: a.quote });
    }
    if (input.recipient === null && input.addresses.length > 1) {
      lines.push({ style: 'note', text: 'Covenant does not know which party you are. Use the other party\'s address, and set "Which party are you?" in the panel to narrow this down.' });
    }
  }

  lines.push({ style: 'heading', text: 'From' });
  lines.push({ style: 'text', text: senderName });
  lines.push({ style: 'heading', text: 'Date' });
  lines.push({ style: 'text', text: blank('date of sending') });
  // The letter goes to the other party, so it names the agreement and its clause, never a Jira key, file type or page of our copy.
  lines.push({ style: 'heading', text: `Subject: ${title} of the agreement between ${senderName} and ${recipientName}` });

  const agreement = `the agreement between ${senderName} and ${recipientName} (${input.fileName})`;
  if (input.renewalClause) {
    const clause = input.renewalClause.clause ?? null;
    lines.push({ style: 'text', text: `We refer to ${agreement}. ${clause ? `Under ${clause}, the` : 'The'} agreement provides:` });
    lines.push({ style: 'quote', text: input.renewalClause.quote });
  } else {
    lines.push({ style: 'text', text: `We refer to ${agreement}.` });
    lines.push({ style: 'note', text: 'Covenant found no renewal clause to cite. Add the clause this notice relies on.' });
  }
  const end = input.termEnd ?? blank('last day of the current term');
  lines.push({
    style: 'text',
    text: nonRenewal
      ? `In accordance with that provision, we give notice that we do not wish the agreement to renew. The agreement will therefore end at the close of the current term on ${end}.`
      : `In accordance with that provision, we give notice that we wish to renew the agreement for a further term from the end of the current term on ${end}.`,
  });
  lines.push({ style: 'text', text: 'Please acknowledge receipt of this notice.' });
  lines.push({ style: 'text', text: blank('name, title and signature of an authorised signatory') });

  lines.push({ style: 'heading', text: 'Before sending: how and by when' });
  lines.push({ style: 'note', text: `The notice must be received by ${input.deadline}.` });
  if (input.methods.length === 0) {
    lines.push({ style: 'note', text: 'The contract does not say how notices must be given. Check with your lawyer which method to use.' });
  }
  for (const m of input.methods) {
    lines.push({ style: 'note', text: `${m.sendBy.label}: ${m.sendBy.latest === null ? 'no send-by date' : `send by ${m.sendBy.latest}`}. ${m.sendBy.rule} From ${m.where}:` });
    lines.push({ style: 'quote', text: m.quote });
  }
  lines.push({ style: 'note', text: 'Every quotation above was checked word for word against the contract file. The dates were worked out by code from those clauses, not by a language model.' });
  return { title, lines };
}

/** The draft as plain text, for tools and for copying into a letter. */
export function draftText(draft: NoticeDraft | { title: string; lines: DraftLine[] }): string {
  return draft.lines.map((l) => (l.style === 'quote' ? `    "${l.text}"` : l.style === 'heading' ? `\n${l.text}` : l.style === 'note' ? `(${l.text})` : l.text)).join('\n');
}

/** The draft as a Jira description. */
export function draftAdf(draft: { title: string; lines: DraftLine[] }): AdfDoc {
  const text = (value: string, strong = false): AdfNode => (strong ? { type: 'text', text: value, marks: [{ type: 'strong' }] } : { type: 'text', text: value });
  const para = (...nodes: AdfNode[]): AdfNode => ({ type: 'paragraph', content: nodes });
  const content = draft.lines.map((l): AdfNode => {
    if (l.style === 'banner') return { type: 'panel', attrs: { panelType: 'warning' }, content: [para(text(l.text, true))] };
    if (l.style === 'heading') return para(text(l.text, true));
    if (l.style === 'quote') return { type: 'blockquote', content: [para(text(l.text))] };
    if (l.style === 'note') return para({ type: 'text', text: l.text, marks: [{ type: 'em' }] });
    return para(text(l.text));
  });
  return { type: 'doc', version: 1, content };
}
