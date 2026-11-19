import type { IsoDate } from './dates/civil';

/**
 * A contract at a glance: the notice deadline in one line, the counts, the
 * next dated obligation, and the one thing a person should do next. The issue
 * panel shows it above everything else, so the value lands before any reading.
 *
 * The next step is chosen by urgency: a renewal decision or a notice that is
 * due, then contract terms to check (every date depends on them), then
 * obligations waiting for review, then a contract value to confirm. When none
 * applies, it says so. Dates and day counts come in already worked out.
 */

export type GlanceWindowStatus = 'no_notice_rule' | 'undated' | 'later' | 'due' | 'passed';
export type GlanceFollowUp = 'none' | 'send_notice' | 'watch_deadline' | 'too_late';
export type GlanceSection = 'decision' | 'terms' | 'obligations' | 'details';

export interface GlanceObligation {
  summary: string;
  decision: 'pending' | 'edited' | 'approving' | 'approved' | 'rejected';
  needsReview: boolean;
  /** The next due date, when it has one. */
  due: IsoDate | null;
  /** True when that date is today or later. */
  upcoming: boolean;
  /** A renewal notice deadline. The deadline line shows it, so it is not repeated as the next date. */
  notice: boolean;
}

export interface GlanceInput {
  window: { status: GlanceWindowStatus; deadline: IsoDate | null; daysLeft: number | null; decisionOpensOn: IsoDate | null };
  /** The decision recorded for this term, or null while none is. `next` says what is left to do, in one sentence. */
  decided: { outcomeLabel: string; followUp: GlanceFollowUp; next: string } | null;
  obligations: readonly GlanceObligation[];
  /** Contract terms (effective date, term, renewal) waiting for a person to check them. */
  termsToCheck: number;
  /** A contract value was read but no person has confirmed one. */
  valueAwaiting: boolean;
  /** The earliest latest-send date across the delivery methods, when known. */
  sendBy: IsoDate | null;
}

export interface Glance {
  deadline: { text: string; label: string | null; tone: 'urgent' | 'calm' | 'settled' | 'missed' | 'none' };
  next: { section: GlanceSection | null; title: string; detail: string; action: string | null; tone: 'urgent' | 'calm' | 'done' };
  counts: { approved: number; waiting: number; rejected: number; needsReview: number };
  nextDate: { summary: string; due: IsoDate } | null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "19 days left", "today", "passed 9 days ago". */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft < 0) return `passed ${plural(-daysLeft, 'day')} ago`;
  if (daysLeft === 0) return 'today';
  return `${plural(daysLeft, 'day')} left`;
}

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

const OPEN_DECISION = 'Open the renewal decision';

function deadlineLine(input: GlanceInput): Glance['deadline'] {
  const w = input.window;
  if (w.status === 'no_notice_rule') {
    // A notice clause the extractor doubted is kept out of the countdown until a person checks it.
    const doubted = input.obligations.some((o) => o.notice && o.needsReview && o.decision !== 'rejected');
    if (doubted) return { text: 'A notice clause needs review before Covenant counts down to it', label: 'Check first', tone: 'urgent' };
    return { text: 'No renewal notice deadline in this contract', label: null, tone: 'none' };
  }
  if (w.status === 'undated' || w.deadline === null) return { text: 'The notice deadline has no date yet', label: 'No date yet', tone: 'urgent' };
  const text = `Notice deadline ${w.deadline}${w.daysLeft === null ? '' : ` (${daysLeftText(w.daysLeft)})`}`;
  if (input.decided) {
    return { text, label: `Decided: ${input.decided.outcomeLabel}`, tone: input.decided.followUp === 'too_late' ? 'missed' : 'settled' };
  }
  if (w.status === 'due') return { text, label: 'Decision due', tone: 'urgent' };
  if (w.status === 'passed') return { text, label: 'Passed', tone: 'missed' };
  return { text, label: 'Not due yet', tone: 'calm' };
}

function countsOf(obligations: readonly GlanceObligation[]): Glance['counts'] {
  const counts = { approved: 0, waiting: 0, rejected: 0, needsReview: 0 };
  for (const o of obligations) {
    if (o.decision === 'approved' || o.decision === 'approving') counts.approved += 1;
    else if (o.decision === 'rejected') counts.rejected += 1;
    else {
      counts.waiting += 1;
      if (o.needsReview) counts.needsReview += 1;
    }
  }
  return counts;
}

function nextDateOf(obligations: readonly GlanceObligation[]): Glance['nextDate'] {
  let best: Glance['nextDate'] = null;
  for (const o of obligations) {
    if (o.decision === 'rejected' || o.notice || !o.upcoming || o.due === null) continue;
    if (best === null || o.due < best.due) best = { summary: o.summary, due: o.due };
  }
  return best;
}

function nextStep(input: GlanceInput, counts: Glance['counts'], nextDate: Glance['nextDate']): Glance['next'] {
  const w = input.window;
  const decided = input.decided;
  const decision = (title: string, detail: string): Glance['next'] => ({ section: 'decision', title, detail, action: OPEN_DECISION, tone: 'urgent' });

  if (decided?.followUp === 'send_notice') return decision(`Send the notice by ${input.sendBy ?? w.deadline ?? 'the deadline'}`, decided.next);
  if (decided?.followUp === 'too_late') return decision('Notice was needed, but the deadline has passed', decided.next);
  if (decided?.followUp === 'watch_deadline' && w.status === 'due' && w.deadline !== null) {
    return decision(`Talks are open: the notice deadline ${w.deadline} still binds`, decided.next);
  }
  if (decided === null && w.status === 'due' && w.deadline !== null) {
    const left = w.daysLeft === null ? '' : `${sentence(daysLeftText(w.daysLeft))} `;
    return decision(
      `Decide by ${w.deadline}: renew, renegotiate or terminate`,
      `${left}The brief has the send-by dates, the drafted notice, the value and the supplier's record.`,
    );
  }
  if (decided === null && w.status === 'passed' && w.deadline !== null) {
    return decision(`The notice deadline passed on ${w.deadline}`, 'No decision was recorded. If the contract renewed, mark it renewed so every date moves to the new term.');
  }
  if (input.termsToCheck > 0) {
    return {
      section: 'terms',
      title: `Check ${plural(input.termsToCheck, 'contract term')}`,
      detail: 'Every date depends on them. Each one shows the clause it came from.',
      action: 'Show the contract terms',
      tone: 'calm',
    };
  }
  if (counts.waiting > 0) {
    const closer = counts.needsReview > 0 ? `${counts.needsReview} of them ${counts.needsReview === 1 ? 'needs' : 'need'} a closer look. ` : '';
    return {
      section: 'obligations',
      title: `Review ${plural(counts.waiting, 'obligation')}`,
      detail: `${closer}Approving one creates its work item with the due date set. Nothing reaches Jira before that.`,
      action: 'Show the obligations',
      tone: 'calm',
    };
  }
  if (input.valueAwaiting) {
    return {
      section: 'details',
      title: 'Confirm the contract value',
      detail: 'The register counts a value only after a person confirms it.',
      action: 'Show notices and value',
      tone: 'calm',
    };
  }
  const parts: string[] = [];
  if (w.status === 'later' && w.decisionOpensOn !== null && decided === null) parts.push(`The renewal decision opens on ${w.decisionOpensOn}.`);
  if (nextDate !== null) parts.push(`Next date is ${nextDate.due}: ${nextDate.summary.trim().replace(/[.\s]+$/, '')}.`);
  const fallback = input.obligations.length === 0 ? 'Covenant found no obligations with deadlines in this contract.' : 'Every obligation has been reviewed.';
  return { section: null, title: 'Nothing needs you right now', detail: parts.length > 0 ? parts.join(' ') : fallback, action: null, tone: 'done' };
}

export function contractGlance(input: GlanceInput): Glance {
  const counts = countsOf(input.obligations);
  const nextDate = nextDateOf(input.obligations);
  return { deadline: deadlineLine(input), next: nextStep(input, counts, nextDate), counts, nextDate };
}
