import type { z } from 'zod';
import { problemDigest, tidyArguments } from './arguments';
import { conflictGroups, contextAround, rereadObligation, rereadTerms, sameTiming } from './critic';
import type { IsoDate } from './dates/civil';
import { type ContractTerms, type Duration, termBounds } from './dates/terms';
import { type NumericOrder, parseWrittenDate } from './dates/written';
import { type LlmClient, type LlmTool, type LlmUsage, NO_USAGE, type ToolCallRequest, type ToolCallResponse, addUsage } from './llm';
import {
  ContractReadingEnvelopeSchema,
  ContractReadingSchema,
  type EffectiveDateReading,
  EffectiveDateReadingSchema,
  type RenewalReading,
  RenewalReadingSchema,
  type TermReading,
  TermReadingSchema,
  type TermsReading,
  toolParameters,
} from './reading';
import { type ObligationRule, ObligationRuleSchema, SCHEMA_VERSION } from './schema';
import { DEFAULT_MIN_QUOTE_CHARS, type QuoteLocation, type QuoteRejection, type SourceDocument, locateQuote, normaliseWhitespace } from './verify';

/**
 * The extractor: one prompt, one forced tool, then code checks everything.
 *
 * 1. The model reads the whole contract and returns term facts and obligation
 *    rules through `record_contract`. A rejected answer goes back once with
 *    the problems listed.
 * 2. Every quote must appear verbatim in the contract, or the item is dropped.
 *    Dates are parsed by code from text copied inside a verified quote.
 * 3. A notice deadline counted back from the end of the term whose clause never
 *    mentions the term is marked "needs review": it may be a right to
 *    terminate on notice, which has no deadline of its own.
 * 4. Low-confidence or conflicting items get a second reading (critic.ts). If
 *    the readings disagree, the item is marked "needs review" and its value is
 *    withheld from the date engine. Never guess.
 */

/** Bump whenever the prompt, the tool or the checks change. Runs are keyed on attachment hash plus this. */
export const EXTRACTOR_VERSION = 4;

/**
 * Words that tie a clause to the contract's duration: the term, its expiry,
 * renewal, an anniversary, or an automatic continuation or extension.
 * "Terminate" and "termination" do not count as "term".
 */
const TERM_WORDS = /\bterms?\b|expir|renew|anniversar|automatic|extend|extension/i;

/** Whether a clause mentions the contract's duration, so a deadline before the end of the term can come from it. */
export const namesTheTerm = (quote: string): boolean => TERM_WORDS.test(quote);

/** About 100k tokens: well inside Haiku's 200k context, with room for the answer. */
export const DEFAULT_MAX_DOCUMENT_CHARS = 400_000;

export interface ExtractOptions {
  maxDocumentChars?: number;
  maxOutputTokens?: number;
  minQuoteChars?: number;
  /** How to read numeric dates like 03/04/2025. Unset: such dates go to review. */
  numericDateOrder?: NumericOrder;
  /** Second-pass settings, or false to send every doubtful item straight to review. */
  critic?: false | { maxSecondPasses?: number; contextChars?: number };
}

export type FactStatus = 'ready' | 'needs_review';

export type ReviewReason =
  /** The second reading gave a different answer. */
  | 'passes_disagree'
  /** Two clauses set different deadlines for the same duty. Precedence is a person's call. */
  | 'conflicting_clauses'
  /** The stated term facts contradict each other, for example a length and an end date that do not match. */
  | 'conflicting_term_facts'
  /** The second reading could not be used. */
  | 'second_pass_failed'
  /** Doubtful, but not re-read: the critic is off or its budget is spent. */
  | 'not_rechecked'
  /** The date as written cannot be read with certainty: blanks, a two-digit year, or day/month order. */
  | 'date_unreadable'
  /** The effective date is an event, such as the last signature. A person enters the date. */
  | 'needs_event_date'
  /** A notice deadline counted from the end of the term, from a clause that never mentions the term: possibly a right to terminate on notice. */
  | 'notice_not_tied_to_term';

/** Why an item needs a person. `detail` names fields and reasons only, never contract text, so it is safe to log. */
export interface ReviewNote {
  reason: ReviewReason;
  detail: string;
}

export type VerifiedLocation = Extract<QuoteLocation, { status: 'verified' }>;

export interface Fact<Reading, Value> {
  status: FactStatus;
  /** What code made of the reading. Always null while the fact needs review. */
  value: Value | null;
  reading: Reading;
  location: VerifiedLocation;
  review: ReviewNote[];
  /** The critic's reading, when there was one. */
  secondReading: Reading | null;
}

export type TermValue =
  | { kind: 'fixed_length'; length: Duration; endDate: IsoDate | null }
  | { kind: 'fixed_end_date'; endDate: IsoDate }
  | { kind: 'until_terminated' };

export interface RenewalValue {
  automatic: boolean;
  length: Duration | null;
}

export interface ExtractedObligation {
  /** Stable within one run: the position in the model's list. */
  id: string;
  status: FactStatus;
  rule: ObligationRule;
  location: VerifiedLocation;
  review: ReviewNote[];
  secondReading: ObligationRule | null;
}

export type RejectedItem = 'effectiveDate' | 'term' | 'renewal' | 'obligation';

/** Something the model reported that code refused to keep. Safe to log: no contract text. */
export interface Rejection {
  item: RejectedItem;
  index?: number;
  reason: QuoteRejection | 'schema' | 'date_not_in_quote';
  detail: string;
}

/** One answer to the first pass: what tidying undid, and what still failed the check. Field names and types only, safe to log. */
export interface AttemptNote {
  tidied: { filledNulls: number; unwrapped: number };
  problems: string[];
}

interface RunInfo {
  /** The model asked for. */
  model: string;
  extractorVersion: number;
  schemaVersion: number;
  usage: LlmUsage;
  calls: number;
  /** Each answer to the first pass, in order: the first, then the repair if there was one. */
  attempts: AttemptNote[];
}

export interface ExtractionSuccess extends RunInfo {
  status: 'ok';
  effectiveDate: Fact<EffectiveDateReading, IsoDate> | null;
  term: Fact<TermReading, TermValue> | null;
  renewal: Fact<RenewalReading, RenewalValue> | null;
  /** Only facts that are ready. This is all the date engine ever sees. */
  contractTerms: ContractTerms;
  obligations: ExtractedObligation[];
  rejected: Rejection[];
  /** Quotes the model returned across all passes, and how many were found verbatim in the contract. */
  grounding: { quotesReturned: number; quotesVerified: number };
  secondPasses: number;
  /** Whether the first answer was rejected and repaired. */
  repaired: boolean;
  /** In the kept answer: fields left out and read as null, and nested values sent as JSON text (arguments.ts). */
  tidied: { filledNulls: number; unwrapped: number };
}

export type FailureReason = 'empty_document' | 'too_long' | 'no_tool_call' | 'invalid_output' | 'llm_error';

export interface ExtractionFailure extends RunInfo {
  status: 'failed';
  reason: FailureReason;
  detail: string;
  /** For invalid_output: what made the last answer unusable, as field names and types only (problemDigest), so safe to log. */
  problems?: string[];
}

export type ExtractionOutcome = ExtractionSuccess | ExtractionFailure;

export const EXTRACT_SYSTEM = [
  'You read a commercial contract and record what it says about time: when it takes effect, how long its initial term lasts, how it renews, and the obligations that have deadlines.',
  'A person reviews everything you record, and code works out every calendar date from your answer. So:',
  '- Never calculate or state a date the text does not write out. Report each deadline as a rule: an anchor, an offset and any recurrence, exactly as the text gives them.',
  '- Dates appear in your answer only as text copied from the contract (dateText, endDateText), and only from inside the quote you give with them.',
  '- Copy every quote character for character from the contract, including punctuation and capitals. Never include the page markers. Quote enough of the sentence to stand on its own.',
  '- Record obligations of these kinds only: renewal_notice, payment, price_change, reporting_deliverable, audit_insurance, service_credit. Leave out obligations that have no deadline or due date.',
  '- Notice of non-renewal or termination that must be given a period before the term ends is renewal_notice with anchor term_end, direction before and recurrence null, even when the contract renews.',
  '- Record each obligation once. If two clauses give different deadlines for the same obligation, record both and give each confidence low.',
  '- When the wording is unclear, record your best reading with confidence low rather than leaving it out.',
  'Call the record_contract tool once with everything you found.',
].join('\n');

export const RECORD_CONTRACT_TOOL: LlmTool = {
  name: 'record_contract',
  description:
    "Record the contract's effective date, initial term, renewal and timed obligations. Call once. Never include a calendar date you worked out yourself.",
  parameters: toolParameters(ContractReadingSchema),
};

/** The contract as the model sees it. Page markers only when the document has real pages. */
export function renderContract(doc: SourceDocument): string {
  if (doc.pages.length === 1) return `<contract>\n${doc.pages[0]?.text ?? ''}\n</contract>`;
  return doc.pages.map((p) => `<page number="${p.page}">\n${p.text}\n</page>`).join('\n');
}

/** Counts every model call and its tokens. */
class Meter {
  usage: LlmUsage = NO_USAGE;
  calls = 0;

  constructor(private readonly llm: LlmClient) {}

  readonly ask = async (request: ToolCallRequest): Promise<ToolCallResponse> => {
    this.calls += 1;
    const response = await this.llm.callTool(request);
    this.usage = addUsage(this.usage, response.usage);
    return response;
  };
}

const issuesOf = (prefix: string, error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((issue) => `${[prefix, ...issue.path.map(String)].filter((p) => p !== '').join('.')}: ${issue.message}`);

interface ParsedReading {
  effectiveDate: EffectiveDateReading | null;
  term: TermReading | null;
  renewal: RenewalReading | null;
  obligations: Array<{ index: number; rule: ObligationRule }>;
  /** Problems that make the answer unusable as a whole: messages for the repair turn, and a digest safe to log. */
  envelope: string[];
  envelopeDigest: string[];
  /** Problems confined to one item, which is dropped if a repair does not fix it. */
  items: Array<{ item: RejectedItem; index?: number; problems: string[]; digest: string[] }>;
  tidied: { filledNulls: number; unwrapped: number };
}

/** Check one item against its schema, keeping messages for the repair turn and a digest safe to log. */
function checkItem<T>(schema: z.ZodType<T>, value: unknown, prefix: string): { ok: true; data: T } | { ok: false; problems: string[]; digest: string[] } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, problems: issuesOf(prefix, parsed.error), digest: problemDigest(prefix, parsed.error, value) };
}

function parseReading(json: string): ParsedReading {
  const empty: ParsedReading = {
    effectiveDate: null,
    term: null,
    renewal: null,
    obligations: [],
    envelope: [],
    envelopeDigest: [],
    items: [],
    tidied: { filledNulls: 0, unwrapped: 0 },
  };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ...empty, envelope: ['the tool arguments are not valid JSON'], envelopeDigest: ['not valid JSON'] };
  }
  // Undo encoding habits (null fields left out, nested values sent as JSON text) before the strict check.
  const tidy = tidyArguments(ContractReadingSchema, parsedJson);
  const raw = tidy.value;
  const tidied = { filledNulls: tidy.filledNulls.length, unwrapped: tidy.unwrapped.length };
  const envelope = ContractReadingEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { ...empty, envelope: issuesOf('', envelope.error), envelopeDigest: problemDigest('', envelope.error, raw), tidied };

  const result: ParsedReading = { ...empty, tidied };
  const effective = checkItem(EffectiveDateReadingSchema.nullable(), envelope.data.effectiveDate, 'effectiveDate');
  if (effective.ok) result.effectiveDate = effective.data;
  else result.items.push({ item: 'effectiveDate', problems: effective.problems, digest: effective.digest });
  const term = checkItem(TermReadingSchema.nullable(), envelope.data.term, 'term');
  if (term.ok) result.term = term.data;
  else result.items.push({ item: 'term', problems: term.problems, digest: term.digest });
  const renewal = checkItem(RenewalReadingSchema.nullable(), envelope.data.renewal, 'renewal');
  if (renewal.ok) result.renewal = renewal.data;
  else result.items.push({ item: 'renewal', problems: renewal.problems, digest: renewal.digest });

  envelope.data.obligations.forEach((candidate, index) => {
    const rule = checkItem(ObligationRuleSchema, candidate, `obligations.${index}`);
    if (rule.ok) result.obligations.push({ index, rule: rule.data });
    else result.items.push({ item: 'obligation', index, problems: rule.problems, digest: rule.digest });
  });
  return result;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'non-error thrown';

/** True when `dateText` sits inside `quote`, whitespace aside. */
const dateInQuote = (dateText: string, quote: string): boolean => normaliseWhitespace(quote).includes(normaliseWhitespace(dateText));

type Built<R, V> = { ok: true; fact: Fact<R, V> } | { ok: false; reason: Rejection['reason']; detail: string };

interface Checker {
  doc: SourceDocument;
  minChars: number;
  numericOrder: NumericOrder | undefined;
  tally: { returned: number; verified: number };
}

function locate(check: Checker, quote: string, page: number | null): VerifiedLocation | QuoteRejection {
  check.tally.returned += 1;
  const location = locateQuote(quote, check.doc, page, { minChars: check.minChars });
  if (location.status === 'rejected') return location.reason;
  check.tally.verified += 1;
  return location;
}

const readDate = (check: Checker, text: string) => parseWrittenDate(text, check.numericOrder ? { numericOrder: check.numericOrder } : {});

function fact<R, V>(reading: R, location: VerifiedLocation, value: V | null, review: ReviewNote[]): Fact<R, V> {
  return { status: review.length === 0 ? 'ready' : 'needs_review', value: review.length === 0 ? value : null, reading, location, review, secondReading: null };
}

function buildEffectiveDate(check: Checker, r: EffectiveDateReading): Built<EffectiveDateReading, IsoDate> {
  const location = locate(check, r.quote, r.page);
  if (typeof location === 'string') return { ok: false, reason: location, detail: `effective date quote ${location}` };
  if (r.dateText === null) {
    return { ok: true, fact: fact<EffectiveDateReading, IsoDate>(r, location, null, [{ reason: 'needs_event_date', detail: 'the effective date is set by an event; a person enters the date' }]) };
  }
  if (!dateInQuote(r.dateText, r.quote)) return { ok: false, reason: 'date_not_in_quote', detail: 'effective date text is not inside its quote' };
  const parsed = readDate(check, r.dateText);
  if (!parsed.ok) return { ok: true, fact: fact<EffectiveDateReading, IsoDate>(r, location, null, [{ reason: 'date_unreadable', detail: `effective date: ${parsed.reason}` }]) };
  return { ok: true, fact: fact(r, location, parsed.date, []) };
}

function buildTerm(check: Checker, r: TermReading): Built<TermReading, TermValue> {
  const location = locate(check, r.quote, r.page);
  if (typeof location === 'string') return { ok: false, reason: location, detail: `term quote ${location}` };
  let endDate: IsoDate | null = null;
  if (r.endDateText !== null) {
    if (!dateInQuote(r.endDateText, r.quote)) return { ok: false, reason: 'date_not_in_quote', detail: 'term end date text is not inside its quote' };
    const parsed = readDate(check, r.endDateText);
    if (!parsed.ok) return { ok: true, fact: fact<TermReading, TermValue>(r, location, null, [{ reason: 'date_unreadable', detail: `term end date: ${parsed.reason}` }]) };
    endDate = parsed.date;
  }
  if (r.kind === 'fixed_length' && r.length !== null) return { ok: true, fact: fact(r, location, { kind: 'fixed_length', length: r.length, endDate }, []) };
  if (r.kind === 'fixed_end_date' && endDate !== null) return { ok: true, fact: fact(r, location, { kind: 'fixed_end_date', endDate }, []) };
  return { ok: true, fact: fact(r, location, { kind: 'until_terminated' }, []) };
}

function buildRenewal(check: Checker, r: RenewalReading): Built<RenewalReading, RenewalValue> {
  const location = locate(check, r.quote, r.page);
  if (typeof location === 'string') return { ok: false, reason: location, detail: `renewal quote ${location}` };
  return { ok: true, fact: fact(r, location, { automatic: r.automatic, length: r.length }, []) };
}

/** Only ready facts reach the engine. */
function contractTermsFrom(
  effective: Fact<EffectiveDateReading, IsoDate> | null,
  term: Fact<TermReading, TermValue> | null,
  renewal: Fact<RenewalReading, RenewalValue> | null,
): ContractTerms {
  const t = term?.status === 'ready' ? term.value : null;
  return {
    effectiveDate: effective?.status === 'ready' ? effective.value : null,
    initialTerm: t?.kind === 'fixed_length' ? t.length : null,
    initialTermEnd: t && t.kind !== 'until_terminated' ? t.endDate : null,
    renewalTerm: renewal?.status === 'ready' ? (renewal.value?.length ?? null) : null,
  };
}

/** Send an item to a person. A fact's value is withdrawn so the engine never computes from it. */
const flag = (item: { status: FactStatus; review: ReviewNote[]; value?: unknown }, note: ReviewNote): void => {
  item.review.push(note);
  item.status = 'needs_review';
  if ('value' in item) item.value = null;
};

const canonical = (value: unknown): string => JSON.stringify(value);

/** Two quotes that overlap or touch on one page are readings of the same passage, not two clauses. */
function samePassage(a: VerifiedLocation, b: VerifiedLocation): boolean {
  if (a.match.pageStart !== b.match.pageStart || a.match.pageEnd !== b.match.pageEnd || a.match.pageStart !== a.match.pageEnd) return false;
  const gap = Math.max(a.match.startOffset, b.match.startOffset) - Math.min(a.match.endOffset, b.match.endOffset);
  return gap <= 3;
}

export async function extractContract(doc: SourceDocument, llm: LlmClient, options: ExtractOptions = {}): Promise<ExtractionOutcome> {
  const meter = new Meter(llm);
  const attempts: AttemptNote[] = [];
  const info = (): RunInfo => ({
    model: llm.modelId,
    extractorVersion: EXTRACTOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    usage: meter.usage,
    calls: meter.calls,
    attempts,
  });
  const failed = (reason: FailureReason, detail: string, problems?: string[]): ExtractionFailure => ({
    ...info(),
    status: 'failed',
    reason,
    detail,
    ...(problems ? { problems } : {}),
  });

  const chars = doc.pages.reduce((sum, p) => sum + p.text.length, 0);
  if (doc.pages.every((p) => p.text.trim() === '')) return failed('empty_document', 'the document has no text');
  const maxChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;
  if (chars > maxChars) return failed('too_long', `${chars} characters; the limit is ${maxChars}`);

  const critic = options.critic === false ? null : { maxSecondPasses: options.critic?.maxSecondPasses ?? 10, contextChars: options.critic?.contextChars ?? 700 };
  const check: Checker = {
    doc,
    minChars: options.minQuoteChars ?? DEFAULT_MIN_QUOTE_CHARS,
    numericOrder: options.numericDateOrder,
    tally: { returned: 0, verified: 0 },
  };

  try {
    // Pass 1, with at most one repair.
    const prompt = `Contract text:\n\n${renderContract(doc)}`;
    let usable: ParsedReading | null = null;
    let lastProblems: string[] = [];
    let repaired = false;
    let repair: ToolCallRequest['repair'];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await meter.ask({
        system: EXTRACT_SYSTEM,
        prompt,
        tool: RECORD_CONTRACT_TOOL,
        maxOutputTokens: options.maxOutputTokens ?? 16_000,
        ...(repair ? { repair } : {}),
      });
      if (response.argumentsJson === null) return failed('no_tool_call', `stop reason ${response.stopReason ?? 'unknown'}`);
      const parsed = parseReading(response.argumentsJson);
      lastProblems = parsed.envelopeDigest;
      attempts.push({ tidied: parsed.tidied, problems: [...parsed.envelopeDigest, ...parsed.items.flatMap((i) => i.digest)] });
      if (parsed.envelope.length === 0) {
        usable = parsed;
        repaired = attempt > 0;
      }
      if (parsed.envelope.length === 0 && parsed.items.length === 0) break;
      repair = { previousArguments: response.argumentsJson, problems: [...parsed.envelope, ...parsed.items.flatMap((i) => i.problems)] };
    }
    if (usable === null) return failed('invalid_output', 'the answer was unusable after one repair', lastProblems);

    const rejected: Rejection[] = usable.items.map((i) => ({
      item: i.item,
      ...(i.index !== undefined ? { index: i.index } : {}),
      reason: 'schema' as const,
      detail: i.digest.join(', '),
    }));
    const keep = <R, V>(item: RejectedItem, built: Built<R, V> | null): Fact<R, V> | null => {
      if (built === null) return null;
      if (built.ok) return built.fact;
      rejected.push({ item, reason: built.reason, detail: built.detail });
      return null;
    };

    // Term facts.
    const effectiveDate = keep('effectiveDate', usable.effectiveDate && buildEffectiveDate(check, usable.effectiveDate));
    const term = keep('term', usable.term && buildTerm(check, usable.term));
    const renewal = keep('renewal', usable.renewal && buildRenewal(check, usable.renewal));

    // Obligations: verified quotes only, exact duplicates dropped.
    const obligations: ExtractedObligation[] = [];
    const seen = new Set<string>();
    for (const { index, rule } of usable.obligations) {
      const location = locate(check, rule.quote, rule.page);
      if (typeof location === 'string') {
        rejected.push({ item: 'obligation', index, reason: location, detail: `obligation ${index} quote ${location}` });
        continue;
      }
      const key = canonical([rule.kind, rule.responsibleParty.toLowerCase(), rule.anchor, rule.offset, rule.recurrence, location.match.pageStart, location.match.startOffset]);
      if (seen.has(key)) continue;
      seen.add(key);
      obligations.push({ id: `o${index}`, status: 'ready', rule, location, review: [], secondReading: null });
    }
    rejected.sort((a, b) => (a.index ?? -1) - (b.index ?? -1));

    // A right to terminate on notice ("either party may terminate on 60 days' notice") has no deadline of its
    // own; read as notice before the term ends, it gives a date the contract never set. A clause that never
    // mentions the term goes to a person. A second reading of the same words would not settle it, so none is made.
    for (const o of obligations) {
      if (o.rule.kind === 'renewal_notice' && o.rule.anchor === 'term_end' && !namesTheTerm(o.rule.quote)) {
        flag(o, { reason: 'notice_not_tied_to_term', detail: 'notice counted from the term end, but the clause does not mention the term, expiry or renewal' });
      }
    }

    // Pass 2 for obligations: low confidence, or a duty with conflicting deadlines among the items still standing.
    let secondPasses = 0;
    const standingIndex = obligations.flatMap((o, i) => (o.status === 'ready' ? [i] : []));
    const groups = conflictGroups(standingIndex.map((i) => (obligations[i] as ExtractedObligation).rule)).map((g) => g.map((j) => standingIndex[j] as number));
    const inConflict = new Set(groups.flat());
    for (const [i, obligation] of obligations.entries()) {
      if (obligation.status !== 'ready') continue;
      if (obligation.rule.confidence !== 'low' && !inConflict.has(i)) continue;
      if (critic === null || secondPasses >= critic.maxSecondPasses) {
        flag(obligation, { reason: 'not_rechecked', detail: 'doubtful reading that was not re-read' });
        continue;
      }
      secondPasses += 1;
      const second = await rereadObligation(meter.ask, doc, obligation.rule, obligation.location.match, {
        contextChars: critic.contextChars,
        minQuoteChars: check.minChars,
      });
      check.tally.returned += second.quotes.returned;
      check.tally.verified += second.quotes.verified;
      if (!second.ok) {
        flag(obligation, { reason: 'second_pass_failed', detail: second.detail });
        continue;
      }
      obligation.secondReading = second.value;
      if (!sameTiming(obligation.rule, second.value)) flag(obligation, { reason: 'passes_disagree', detail: 'the second reading gave different timing' });
    }
    for (const group of groups) {
      const members = group.map((i) => obligations[i]).filter((o): o is ExtractedObligation => o !== undefined);
      const standing = members.filter((o) => o.status === 'ready');
      const distinct = new Set(standing.map((o) => canonical([o.rule.offset, o.rule.recurrence])));
      if (distinct.size > 1) {
        for (const o of standing) flag(o, { reason: 'conflicting_clauses', detail: `${standing.length} clauses set different deadlines for this duty` });
        continue;
      }
      // A second reading can "settle" a real conflict by reading the other clause in its context window.
      // If a member the second reading overturned sits in a different passage from a standing member with a
      // different deadline, two clauses still disagree, and precedence is a person's call.
      const overturned = members.filter((o) => o.status !== 'ready' && o.review.some((n) => n.reason === 'passes_disagree'));
      for (const s of standing) {
        const rival = overturned.find((o) => !sameTiming(o.rule, s.rule) && !samePassage(o.location, s.location));
        if (rival) flag(s, { reason: 'conflicting_clauses', detail: 'another clause sets a different deadline for this duty' });
      }
    }

    // Pass 2 for term facts: low confidence, or facts the engine finds contradictory.
    const doubtful = new Set<'effectiveDate' | 'term' | 'renewal'>();
    const ready = { effectiveDate: effectiveDate?.status === 'ready', term: term?.status === 'ready', renewal: renewal?.status === 'ready' };
    if (ready.effectiveDate && effectiveDate?.reading.confidence === 'low') doubtful.add('effectiveDate');
    if (ready.term && term?.reading.confidence === 'low') doubtful.add('term');
    if (ready.renewal && renewal?.reading.confidence === 'low') doubtful.add('renewal');
    const engineConflict = (): boolean => {
      const bounds = termBounds(contractTermsFrom(effectiveDate, term, renewal), 0);
      return !bounds.ok && bounds.reason === 'conflicting_term_facts';
    };
    if (engineConflict()) {
      if (ready.effectiveDate) doubtful.add('effectiveDate');
      if (ready.term) doubtful.add('term');
    }

    if (doubtful.size > 0) {
      const facts = { effectiveDate, term, renewal };
      if (critic === null || secondPasses >= critic.maxSecondPasses) {
        for (const name of doubtful) {
          const f = facts[name];
          if (f) flag(f, { reason: 'not_rechecked', detail: `${name} was doubtful and not re-read` });
        }
      } else {
        secondPasses += 1;
        const opening = doc.pages[0]?.text.slice(0, 1500) ?? '';
        const excerpts = [opening, ...[...doubtful].map((name) => facts[name]).filter((f) => f !== null).map((f) => contextAround(doc, f.location.match, critic.contextChars))];
        const second = await rereadTerms(meter.ask, excerpts);
        if (!second.ok) {
          for (const name of doubtful) {
            const f = facts[name];
            if (f) flag(f, { reason: 'second_pass_failed', detail: second.detail });
          }
        } else {
          compareTerms(check, second.value, doubtful, facts);
        }
      }
    }
    if (engineConflict()) {
      for (const f of [effectiveDate, term]) {
        if (f?.status === 'ready') flag(f, { reason: 'conflicting_term_facts', detail: 'the stated term length and end date do not agree' });
      }
    }

    return {
      ...info(),
      status: 'ok',
      effectiveDate,
      term,
      renewal,
      contractTerms: contractTermsFrom(effectiveDate, term, renewal),
      obligations,
      rejected,
      grounding: { quotesReturned: check.tally.returned, quotesVerified: check.tally.verified },
      secondPasses,
      repaired,
      tidied: usable.tidied,
    };
  } catch (error) {
    return failed('llm_error', describeError(error));
  }
}

/** Compare each doubtful fact with its second reading; a different value, or none, sends it to review. */
function compareTerms(
  check: Checker,
  second: TermsReading,
  doubtful: ReadonlySet<'effectiveDate' | 'term' | 'renewal'>,
  facts: {
    effectiveDate: Fact<EffectiveDateReading, IsoDate> | null;
    term: Fact<TermReading, TermValue> | null;
    renewal: Fact<RenewalReading, RenewalValue> | null;
  },
): void {
  const settle = <R, V>(first: Fact<R, V> | null, reading: R | null, build: (r: R) => Built<R, V>, name: string): void => {
    if (first === null) return;
    first.secondReading = reading;
    const again = reading === null ? null : build(reading);
    const agrees = again !== null && again.ok && again.fact.status === 'ready' && canonical(again.fact.value) === canonical(first.value);
    if (!agrees) flag(first, { reason: 'passes_disagree', detail: `the second reading of ${name} differs` });
  };
  if (doubtful.has('effectiveDate')) settle(facts.effectiveDate, second.effectiveDate, (r) => buildEffectiveDate(check, r), 'the effective date');
  if (doubtful.has('term')) settle(facts.term, second.term, (r) => buildTerm(check, r), 'the term');
  if (doubtful.has('renewal')) settle(facts.renewal, second.renewal, (r) => buildRenewal(check, r), 'the renewal');
}
