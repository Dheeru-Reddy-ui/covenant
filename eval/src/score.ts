import { type Duration, type ExtractionOutcome, type IsoDate, type VerifiedLocation, termBounds } from '../../packages/core/src';
import { type CuadContract, type GoldSpan, LABELS, type Label } from './cuad';

/**
 * Scores one extraction against CUAD's labels. Definitions, all per
 * (contract, label) pair:
 *
 * - clause recall: of pairs where CUAD highlights a span, the share where one
 *   of our verified quotes for that label covers at least half of a CUAD span
 *   (or a CUAD span covers half of ours).
 * - exact match: of pairs whose CUAD answer is a usable value, the share where
 *   our final value equals it. Abstaining or finding nothing counts as a miss.
 * - abstain rate: of the same pairs, the share where we found the clause but
 *   withheld the value for a person (needs review, or the engine refused).
 * - grounding (per run): quotes found verbatim / quotes the model returned.
 */

// ---------- CUAD's answers ----------

export type GoldDate = { kind: 'date'; month: number; day: number; yy: number } | { kind: 'blank' } | { kind: 'perpetual' } | { kind: 'none' } | { kind: 'other' };

/** CUAD writes dates m/d/yy ("4/1/18"), with [] for blanks the contract left unfilled ("[]/[]/2020"). */
export function parseGoldDate(answer: string): GoldDate {
  const s = answer.trim();
  if (s === '') return { kind: 'none' };
  if (/^perpetual\b/i.test(s)) return { kind: 'perpetual' };
  if (s.includes('[')) return { kind: 'blank' };
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return { kind: 'other' };
  return { kind: 'date', month: Number(m[1]), day: Number(m[2]), yy: Number(m[3]) % 100 };
}

export type GoldDurations = { kind: 'durations'; values: Duration[] } | { kind: 'blank' } | { kind: 'perpetual' } | { kind: 'none' } | { kind: 'other' };

const UNIT_WORDS: ReadonlyArray<[RegExp, Duration['unit']]> = [
  [/^business days?$/i, 'business_day'],
  [/^days?$/i, 'day'],
  [/^weeks?$/i, 'week'],
  [/^months?$/i, 'month'],
  [/^years?$/i, 'year'],
];

/** "successive 1 year", "(6) months", "60) days", "180 days / 6 months", "6 months; 12 months". */
export function parseGoldDurations(answer: string): GoldDurations {
  const s = answer.trim();
  if (s === '') return { kind: 'none' };
  if (s.includes('[')) return { kind: 'blank' };
  if (/^perpetual\b/i.test(s)) return { kind: 'perpetual' };
  const values: Duration[] = [];
  for (const part of s.split(/[;/,]/)) {
    const m = /(\d+)\)?\s*(business days?|days?|weeks?|months?|years?)\b/i.exec(part);
    if (!m) continue;
    const unit = UNIT_WORDS.find(([re]) => re.test(m[2] ?? ''))?.[1];
    if (unit) values.push({ count: Number(m[1]), unit });
  }
  return values.length > 0 ? { kind: 'durations', values } : { kind: 'other' };
}

/** Equal lengths of time as a contract states them: 12 months is 1 year, 2 weeks is 14 days; business days only equal business days. */
export function sameDuration(a: Duration, b: Duration): boolean {
  const measure = (d: Duration): [string, number] => {
    if (d.unit === 'year') return ['months', d.count * 12];
    if (d.unit === 'month') return ['months', d.count];
    if (d.unit === 'week') return ['days', d.count * 7];
    if (d.unit === 'day') return ['days', d.count];
    return ['business_days', d.count];
  };
  const [ua, na] = measure(a);
  const [ub, nb] = measure(b);
  return ua === ub && na === nb;
}

// ---------- Our answers ----------

export type Answer<T> = { kind: 'value'; value: T } | { kind: 'abstained'; why: string } | { kind: 'none' };

export type Expiry = { perpetual: true } | { perpetual: false; endDates: IsoDate[] };

type Ok = Extract<ExtractionOutcome, { status: 'ok' }>;
const ok = (outcome: ExtractionOutcome | null): Ok | null => (outcome?.status === 'ok' ? outcome : null);
const reasons = (notes: ReadonlyArray<{ reason: string }>): string => notes.map((n) => n.reason).join('+');

export function ourEffectiveDate(outcome: ExtractionOutcome | null): Answer<IsoDate> {
  const fact = ok(outcome)?.effectiveDate;
  if (!fact) return { kind: 'none' };
  if (fact.status === 'needs_review' || fact.value === null) return { kind: 'abstained', why: reasons(fact.review) };
  return { kind: 'value', value: fact.value };
}

/**
 * The initial term's end, computed by the date engine from verified facts. CUAD
 * does not say whether a "two-year term from 1 March 2025" ends on 28 Feb or 1 Mar
 * 2027, so both conventions are computed and the report says which matched.
 */
export function ourExpiration(outcome: ExtractionOutcome | null): Answer<Expiry> {
  const run = ok(outcome);
  const fact = run?.term;
  if (!run || !fact) return { kind: 'none' };
  if (fact.status === 'needs_review' || fact.value === null) return { kind: 'abstained', why: reasons(fact.review) };
  if (fact.value.kind === 'until_terminated') return { kind: 'value', value: { perpetual: true } };
  const ends: IsoDate[] = [];
  let refusal = '';
  for (const termEndConvention of ['day_before_anniversary', 'anniversary'] as const) {
    const bounds = termBounds(run.contractTerms, 0, { termEndConvention });
    if (bounds.ok) ends.push(bounds.value.end);
    else refusal = bounds.reason;
  }
  return ends.length > 0 ? { kind: 'value', value: { perpetual: false, endDates: ends } } : { kind: 'abstained', why: `engine:${refusal}` };
}

export function ourRenewalTerm(outcome: ExtractionOutcome | null): Answer<Duration> {
  const fact = ok(outcome)?.renewal;
  if (!fact) return { kind: 'none' };
  if (fact.status === 'needs_review' || fact.value === null) return { kind: 'abstained', why: reasons(fact.review) };
  if (fact.value.length === null) return { kind: 'abstained', why: 'no_length_stated' };
  return { kind: 'value', value: fact.value.length };
}

const isNotice = (o: Ok['obligations'][number]): boolean =>
  o.rule.kind === 'renewal_notice' && o.rule.anchor === 'term_end' && o.rule.offset.direction === 'before';

export function ourNoticePeriod(outcome: ExtractionOutcome | null): Answer<Duration> {
  const run = ok(outcome);
  if (!run) return { kind: 'none' };
  const notices = run.obligations.filter(isNotice);
  const ready = notices.filter((n) => n.status === 'ready');
  const distinct = [...new Map(ready.map((n) => [`${n.rule.offset.count} ${n.rule.offset.unit}`, n.rule.offset])).values()];
  if (distinct.length === 1 && distinct[0]) return { kind: 'value', value: { count: distinct[0].count, unit: distinct[0].unit } };
  if (distinct.length > 1) return { kind: 'abstained', why: 'several_notice_periods' };
  if (notices.length > 0) return { kind: 'abstained', why: [...new Set(notices.map((n) => reasons(n.review)))].join(',') };
  return { kind: 'none' };
}

/** Where our quotes for a label sit in the contract text (single page). */
export function ourSpans(outcome: ExtractionOutcome | null, label: Label): GoldSpan[] {
  const run = ok(outcome);
  if (!run) return [];
  const span = (l: VerifiedLocation): GoldSpan => ({ start: l.match.startOffset, end: l.match.endOffset });
  switch (label) {
    case 'Effective Date':
      return run.effectiveDate ? [span(run.effectiveDate.location)] : [];
    case 'Expiration Date':
      return run.term ? [span(run.term.location)] : [];
    case 'Renewal Term':
      return run.renewal ? [span(run.renewal.location)] : [];
    case 'Notice Period To Terminate Renewal':
      return run.obligations.filter((o) => o.rule.kind === 'renewal_notice').map((o) => span(o.location));
  }
}

/** True when some pair of spans overlaps by at least half of the shorter one. */
export function spansOverlap(ours: readonly GoldSpan[], gold: readonly GoldSpan[]): boolean {
  return ours.some((a) =>
    gold.some((b) => {
      const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      const shorter = Math.min(a.end - a.start, b.end - b.start);
      return shorter > 0 && shared >= shorter / 2;
    }),
  );
}

// ---------- Pair scores ----------

export type GoldClass = 'scorable' | 'blank' | 'none' | 'other';

export interface PairScore {
  contract: string;
  label: Label;
  goldClass: GoldClass;
  answer: Answer<unknown>['kind'];
  /** Null when CUAD has no usable value to compare with. */
  exact: boolean | null;
  /** Null when CUAD highlights no span for this label. */
  recall: boolean | null;
  /** Why we abstained, when we did. */
  why?: string;
  /** For expiration dates: which term-end convention matched. */
  matchedConvention?: 'day_before_anniversary' | 'anniversary';
}

const dateMatches = (iso: IsoDate, gold: Extract<GoldDate, { kind: 'date' }>): boolean => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return m === gold.month && d === gold.day && y % 100 === gold.yy;
};

const classOf = (kind: string, perpetualScorable: boolean): GoldClass => {
  if (kind === 'date' || kind === 'durations' || (kind === 'perpetual' && perpetualScorable)) return 'scorable';
  if (kind === 'blank') return 'blank';
  if (kind === 'none') return 'none';
  return 'other';
};

function pair(contract: CuadContract, outcome: ExtractionOutcome | null, label: Label): PairScore {
  const gold = contract.spans[label];
  const recall = gold.length === 0 ? null : spansOverlap(ourSpans(outcome, label), gold);
  const base = { contract: contract.id, label, recall };
  const withWhy = (a: Answer<unknown>) => (a.kind === 'abstained' ? { why: a.why } : {});

  switch (label) {
    case 'Effective Date': {
      const g = parseGoldDate(contract.answers[label]);
      const a = ourEffectiveDate(outcome);
      const exact = g.kind === 'date' ? a.kind === 'value' && dateMatches(a.value, g) : null;
      return { ...base, goldClass: classOf(g.kind, false), answer: a.kind, exact, ...withWhy(a) };
    }
    case 'Expiration Date': {
      const g = parseGoldDate(contract.answers[label]);
      const a = ourExpiration(outcome);
      let exact: boolean | null = null;
      let matchedConvention: PairScore['matchedConvention'];
      if (g.kind === 'perpetual') exact = a.kind === 'value' && a.value.perpetual;
      if (g.kind === 'date') {
        exact = false;
        if (a.kind === 'value' && !a.value.perpetual) {
          const hit = a.value.endDates.findIndex((end) => dateMatches(end, g));
          if (hit >= 0) {
            exact = true;
            matchedConvention = hit === 0 ? 'day_before_anniversary' : 'anniversary';
          }
        }
      }
      return { ...base, goldClass: classOf(g.kind, true), answer: a.kind, exact, ...withWhy(a), ...(matchedConvention ? { matchedConvention } : {}) };
    }
    case 'Renewal Term':
    case 'Notice Period To Terminate Renewal': {
      const g = parseGoldDurations(contract.answers[label]);
      const a = label === 'Renewal Term' ? ourRenewalTerm(outcome) : ourNoticePeriod(outcome);
      const exact = g.kind === 'durations' ? a.kind === 'value' && g.values.some((v) => sameDuration(v, a.value)) : null;
      return { ...base, goldClass: classOf(g.kind, false), answer: a.kind, exact, ...withWhy(a) };
    }
  }
}

export function scoreContract(contract: CuadContract, outcome: ExtractionOutcome | null): PairScore[] {
  return LABELS.map((label) => pair(contract, outcome, label));
}

// ---------- Aggregates ----------

export interface Metrics {
  pairs: number;
  /** Pairs where CUAD gives a usable value. The denominator for exact match and abstain rate. */
  scorable: number;
  exact: number;
  /** Scorable pairs where we gave a value (right or wrong). */
  answered: number;
  abstained: number;
  noAnswer: number;
  /** Pairs where CUAD highlights a clause, and how many our quotes covered. */
  clauseGold: number;
  clauseHits: number;
  /** CUAD left the date blank in the contract; the right move is to withhold a value. */
  blankGold: number;
  blankWithheld: number;
  /** CUAD has no answer at all, but we gave a value. Not all are wrong: CUAD can miss clauses. */
  valueWithoutGold: number;
}

export function aggregate(scores: readonly PairScore[]): Metrics {
  const scorable = scores.filter((s) => s.goldClass === 'scorable');
  const blank = scores.filter((s) => s.goldClass === 'blank');
  const withSpans = scores.filter((s) => s.recall !== null);
  return {
    pairs: scores.length,
    scorable: scorable.length,
    exact: scorable.filter((s) => s.exact === true).length,
    answered: scorable.filter((s) => s.answer === 'value').length,
    abstained: scorable.filter((s) => s.answer === 'abstained').length,
    noAnswer: scorable.filter((s) => s.answer === 'none').length,
    clauseGold: withSpans.length,
    clauseHits: withSpans.filter((s) => s.recall === true).length,
    blankGold: blank.length,
    blankWithheld: blank.filter((s) => s.answer !== 'value').length,
    valueWithoutGold: scores.filter((s) => s.goldClass === 'none' && s.answer === 'value').length,
  };
}

export const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);
