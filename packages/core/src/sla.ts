import { addBusinessDays, countBusinessDays } from './dates/business';
import { type IsoDate, addDays, addMonths, compareDates, endOfMonth, fromDayNumber, startOfMonth, yearMonth } from './dates/civil';
import { type HolidayList, WEEKENDS_ONLY, calendarOf } from './dates/holidays';
import type { ServiceLevelData } from './details';
import { type Money, formatMoney } from './money';
import type { DraftLine } from './notice';

/**
 * Clause to claim: the contract's own service levels, measured against the
 * incidents a team already tracks in Jira. Code counts and times; the model
 * only read the clause. Two things can be measured from Jira: how many
 * incidents there were, and how long each took to resolve. Anything else,
 * such as uptime, is reported as "cannot be measured here", never estimated.
 */

export interface IncidentFact {
  key: string;
  /** Epoch milliseconds. */
  createdMs: number;
  /** Null while the incident is open. */
  resolvedMs: number | null;
}

export interface Breach {
  /** The period the breach belongs to, such as "November 2026", or null for a single incident. */
  periodLabel: string | null;
  workItems: string[];
  /** What happened against what was promised, in words and numbers. */
  detail: string;
  /** The last day to claim, when the contract sets a limit. */
  claimBy: IsoDate | null;
  /** Whether the claim window is still open today. Null when the contract sets no limit. */
  claimOpen: boolean | null;
}

export type Measurement =
  | { status: 'cannot_measure'; reason: string }
  | {
      status: 'measured';
      /** One line on what Jira shows for this term. */
      observed: string;
      incidents: number;
      breaches: Breach[];
    };

export interface MeasureContext {
  /** The current term: only incidents created inside it count. */
  termStart: IsoDate;
  termEnd: IsoDate;
  today: IsoDate;
  nowMs: number;
  holidays?: HolidayList;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The UTC calendar date of a moment. */
export const dateOfMs = (ms: number): IsoDate => fromDayNumber(Math.floor(ms / DAY_MS));

interface Period {
  start: IsoDate;
  end: IsoDate;
  label: string;
}

function periodOf(date: IsoDate, unit: 'month' | 'quarter' | 'year'): Period {
  const { year, month } = yearMonth(date);
  if (unit === 'month') {
    const start = startOfMonth(date);
    return { start, end: endOfMonth(date), label: `${MONTHS[month - 1]} ${year}` };
  }
  if (unit === 'quarter') {
    const q = Math.floor((month - 1) / 3);
    const start = `${year}-${String(q * 3 + 1).padStart(2, '0')}-01`;
    return { start, end: endOfMonth(addMonths(start, 2)), label: `Q${q + 1} ${year}` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function claimWindow(claim: ServiceLevelData['claim'], from: { incident: IsoDate; periodEnd: IsoDate }, ctx: MeasureContext): Pick<Breach, 'claimBy' | 'claimOpen'> {
  if (claim === null) return { claimBy: null, claimOpen: null };
  const base = claim.from === 'period_end' ? from.periodEnd : from.incident;
  const claimBy = claim.unit === 'business_day' ? addBusinessDays(base, claim.count, calendarOf(ctx.holidays ?? WEEKENDS_ONLY)) : addDays(base, claim.count);
  return { claimBy, claimOpen: compareDates(ctx.today, claimBy) <= 0 };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const round1 = (n: number): string => (Math.round(n * 10) / 10).toString();

export function measureServiceLevel(sl: Pick<ServiceLevelData, 'metric' | 'threshold' | 'period' | 'claim'>, incidents: readonly IncidentFact[], ctx: MeasureContext): Measurement {
  const inTerm = incidents
    .filter((i) => {
      const d = dateOfMs(i.createdMs);
      return compareDates(d, ctx.termStart) >= 0 && compareDates(d, ctx.termEnd) <= 0 && compareDates(d, ctx.today) <= 0;
    })
    .sort((a, b) => a.createdMs - b.createdMs);

  if (sl.metric === 'incident_count') {
    if (sl.threshold.unit !== 'incident') return { status: 'cannot_measure', reason: 'The clause does not cap incidents as a plain number, so Covenant cannot count against it.' };
    if (sl.period === null) return { status: 'cannot_measure', reason: 'The clause gives no measurement period, so Covenant cannot tell which incidents to count together.' };
    const unit = sl.period;
    const groups = new Map<string, { period: Period; items: IncidentFact[] }>();
    for (const i of inTerm) {
      const period = periodOf(dateOfMs(i.createdMs), unit);
      const g = groups.get(period.start) ?? { period, items: [] };
      g.items.push(i);
      groups.set(period.start, g);
    }
    const breaches: Breach[] = [];
    for (const { period, items } of groups.values()) {
      if (items.length <= sl.threshold.count) continue;
      const last = items[items.length - 1] as IncidentFact;
      breaches.push({
        periodLabel: period.label,
        workItems: items.map((i) => i.key),
        detail: `${plural(items.length, 'incident')} in ${period.label}; the contract allows ${sl.threshold.count}.`,
        ...claimWindow(sl.claim, { incident: dateOfMs(last.createdMs), periodEnd: period.end }, ctx),
      });
    }
    return {
      status: 'measured',
      incidents: inTerm.length,
      observed: `${plural(inTerm.length, 'incident')} this term; ${breaches.length === 0 ? `no ${unit} went over the limit of ${sl.threshold.count}` : `${plural(breaches.length, unit)} over the limit of ${sl.threshold.count}`}.`,
      breaches,
    };
  }

  if (sl.metric === 'resolution_time') {
    const { count, unit } = sl.threshold;
    if (unit !== 'hour' && unit !== 'day' && unit !== 'business_day') {
      return { status: 'cannot_measure', reason: `The clause measures resolution in ${unit.replace('_', ' ')}s, which Jira's created and resolved times cannot give. It cannot be measured here.` };
    }
    const calendar = calendarOf(ctx.holidays ?? WEEKENDS_ONLY);
    const breaches: Breach[] = [];
    let slowest = 0;
    for (const i of inTerm) {
      const endMs = i.resolvedMs ?? ctx.nowMs;
      const created = dateOfMs(i.createdMs);
      const took = unit === 'hour' ? (endMs - i.createdMs) / HOUR_MS : unit === 'day' ? (endMs - i.createdMs) / DAY_MS : countBusinessDays(created, dateOfMs(endMs), calendar);
      slowest = Math.max(slowest, took);
      if (took <= count) continue;
      const unitWord = unit === 'business_day' ? 'business day' : unit;
      const period = periodOf(created, sl.period ?? 'month');
      breaches.push({
        periodLabel: null,
        workItems: [i.key],
        detail: `${i.key} ${i.resolvedMs === null ? 'has been open for' : 'took'} ${round1(took)} ${unitWord}s; the contract allows ${count}.`,
        ...claimWindow(sl.claim, { incident: dateOfMs(endMs), periodEnd: period.end }, ctx),
      });
    }
    return {
      status: 'measured',
      incidents: inTerm.length,
      observed:
        inTerm.length === 0
          ? 'No incidents this term.'
          : `${plural(inTerm.length, 'incident')} this term; ${breaches.length === 0 ? 'all within' : `${breaches.length} over`} the limit of ${plural(count, unit === 'business_day' ? 'business day' : unit)}.`,
      breaches,
    };
  }

  const what = sl.metric === 'uptime' ? 'Uptime' : sl.metric === 'response_time' ? 'Response time' : 'This commitment';
  return { status: 'cannot_measure', reason: `${what} cannot be measured here: Jira work items record when an incident was created and resolved, not this. Check the supplier's own report.` };
}

export type CreditTerms = NonNullable<ServiceLevelData['credit']>;

/**
 * The credit owed for a set of breaches, when the contract states a percentage of a fee and the fee is known.
 * Null means "quote the formula": the percentage, its base or the fee is missing, and nothing is estimated.
 */
export function creditAmount(credit: Pick<CreditTerms, 'percent' | 'of' | 'per'> | null, breaches: readonly Breach[], yearlyFee: Money | null): Money | null {
  if (credit === null || credit.percent === null || credit.of === null || credit.of === 'other' || credit.per === null || yearlyFee === null || breaches.length === 0) return null;
  const divisor = credit.of === 'monthly_fee' ? 12 : credit.of === 'quarterly_fee' ? 4 : 1;
  const base = Math.round(yearlyFee.minor / divisor);
  const times = credit.per === 'period' ? new Set(breaches.map((b) => b.periodLabel ?? b.workItems.join(','))).size : breaches.length;
  return { minor: Math.round((base * credit.percent) / 100) * times, currency: yearlyFee.currency };
}

/** A quote with where it sits for the person sending ("clause 3.2 (Service levels), page 4") and the numbered clause the letter itself cites, when code found one. */
interface ClaimCitation {
  quote: string;
  where: string;
  clause?: string | null;
}

export interface ClaimDraftInput {
  fileName: string;
  supplier: string | null;
  commitment: ClaimCitation;
  credit: ClaimCitation | null;
  claimClause: ClaimCitation | null;
  breaches: Breach[];
  amount: Money | null;
  claimBy: IsoDate | null;
}

/** A service credit claim for a person to check and send. It cites the clause and lists the work items behind each breach. */
export function draftClaim(input: ClaimDraftInput): { title: string; lines: DraftLine[] } {
  const lines: DraftLine[] = [{ style: 'banner', text: 'DRAFT FOR REVIEW. Covenant wrote this from the contract and from Jira. It has not been sent, and it is not legal advice.' }];
  lines.push({ style: 'heading', text: `To: ${input.supplier ?? '[supplier, as named in the contract]'}` });
  // The letter goes to the supplier: it cites clauses as the contract numbers them, never our Jira key for the contract, a file type or a page of our copy.
  const under = (c: ClaimCitation, rest: string): string => (c.clause ? `Under ${c.clause}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));
  lines.push({ style: 'heading', text: 'Subject: Service credit claim' });
  lines.push({ style: 'text', text: `We refer to the agreement (${input.fileName}). ${under(input.commitment, 'you committed:')}` });
  lines.push({ style: 'quote', text: input.commitment.quote });
  lines.push({ style: 'text', text: 'Our records show this commitment was not met:' });
  for (const b of input.breaches) lines.push({ style: 'text', text: `- ${b.detail} Work items: ${b.workItems.join(', ')}.` });
  if (input.credit) {
    lines.push({ style: 'text', text: under(input.credit, 'the agreement provides:') });
    lines.push({ style: 'quote', text: input.credit.quote });
    lines.push({
      style: 'text',
      text: input.amount ? `On that basis we claim a service credit of ${formatMoney(input.amount)}.` : 'We claim the service credit due under that provision. [amount: work it out from the formula above]',
    });
  } else {
    lines.push({ style: 'note', text: 'Covenant found no service credit clause for this commitment, so no amount is claimed here. Check the contract for the remedy.' });
  }
  if (input.claimClause) {
    lines.push({ style: 'note', text: `Claim deadline${input.claimBy ? `: ${input.claimBy}` : ''}, from ${input.claimClause.where}:` });
    lines.push({ style: 'quote', text: input.claimClause.quote });
  }
  lines.push({ style: 'note', text: 'Code counted the incidents and worked out the dates and the amount. Every quotation was checked word for word against the contract file.' });
  return { title: 'Service credit claim', lines };
}

export interface LeverageInput {
  contractTitle: string;
  deadline: IsoDate | null;
  daysLeft: number | null;
  termEnd: IsoDate | null;
  yearlyValue: Money | null;
  records: Array<{ summary: string; where: string; measurement: Measurement; credit: Money | null }>;
}

/** One page of facts to take into a renegotiation: what was promised, what Jira shows, what is owed, and how long is left. */
export function leverageSummary(input: LeverageInput): { title: string; lines: DraftLine[] } {
  const lines: DraftLine[] = [{ style: 'heading', text: `Renegotiation summary: ${input.contractTitle}` }];
  lines.push({
    style: 'text',
    text:
      input.deadline === null
        ? 'No notice deadline is confirmed for this contract.'
        : `Notice deadline ${input.deadline}${input.daysLeft !== null && input.daysLeft >= 0 ? ` (${plural(input.daysLeft, 'day')} left)` : ''}${input.termEnd ? `; the current term ends ${input.termEnd}` : ''}. Until notice is given, the option to walk away is still open.`,
  });
  lines.push({ style: 'text', text: input.yearlyValue ? `Value: ${formatMoney(input.yearlyValue)} a year.` : 'Value: not confirmed in Covenant.' });
  const measured = input.records.filter((r) => r.measurement.status === 'measured');
  if (input.records.length === 0) lines.push({ style: 'text', text: 'The contract states no service levels that Covenant found.' });
  for (const r of input.records) {
    lines.push({ style: 'heading', text: `${r.summary} (${r.where})` });
    if (r.measurement.status === 'cannot_measure') {
      lines.push({ style: 'note', text: r.measurement.reason });
      continue;
    }
    lines.push({ style: 'text', text: r.measurement.observed });
    for (const b of r.measurement.breaches) lines.push({ style: 'text', text: `- ${b.detail} (${b.workItems.join(', ')})${b.claimBy ? `; claim by ${b.claimBy}${b.claimOpen === false ? ', now closed' : ''}` : ''}` });
    if (r.credit) lines.push({ style: 'text', text: `Service credits claimable: ${formatMoney(r.credit)}.` });
  }
  const breaches = measured.reduce((n, r) => n + (r.measurement.status === 'measured' ? r.measurement.breaches.length : 0), 0);
  lines.push({
    style: 'text',
    text:
      breaches > 0
        ? `In short: ${plural(breaches, 'breach')} of the contract's own service levels this term, each traceable to a Jira work item.`
        : measured.length > 0
          ? 'In short: Jira shows no breach of the measurable service levels this term.'
          : 'In short: nothing here could be measured from Jira.',
  });
  lines.push({ style: 'note', text: 'Counts and amounts were worked out by code from Jira work items and the cited clauses.' });
  return { title: 'Renegotiation summary', lines };
}
