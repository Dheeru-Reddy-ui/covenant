import type { LlmTool, ToolCallRequest, ToolCallResponse } from './llm';
import { TermsReadingSchema, type TermsReading, toolParameters } from './reading';
import { type ObligationRule, ObligationRuleSchema } from './schema';
import { type QuoteMatch, type SourceDocument, locateQuote } from './verify';

/**
 * The critic: an independent second reading for anything the first pass was
 * unsure of or that conflicts with another clause. It is told what to look
 * for (which obligation, or which term facts) and shown the text around the
 * clause, never the first reading's answer. If the two readings disagree, the
 * item goes to a person as "needs review". Nothing here picks a winner.
 */

export const CLAUSE_TOOL: LlmTool = {
  name: 'record_clause_rule',
  description: 'Record the timing of one obligation as a rule. Call once. Never include a calendar date you worked out yourself.',
  parameters: toolParameters(ObligationRuleSchema),
};

export const TERMS_TOOL: LlmTool = {
  name: 'record_terms',
  description: "Record the contract's effective date, initial term and renewal. Call once. Dates only as written inside the quote.",
  parameters: toolParameters(TermsReadingSchema),
};

export const CLAUSE_SYSTEM = [
  'You check one obligation in a contract by reading its clause afresh.',
  'Report the timing of the obligation named in the request as a rule: its anchor, offset and recurrence, exactly as the text gives them.',
  'Never calculate or state a calendar date.',
  'A deadline measured from the end of the term uses anchor term_end with recurrence null, even when the contract renews.',
  'Copy the quote character for character from the text.',
  'If the text is unclear about this obligation, give your best reading with confidence low.',
  'Call record_clause_rule once.',
].join(' ');

export const TERMS_SYSTEM = [
  'You check when a contract takes effect, how long its initial term lasts and how it renews, by reading the extracts afresh.',
  'Never calculate or state a date the text does not write out: copy dates exactly as written, from inside the quote you give with them.',
  'Copy every quote character for character from the extracts.',
  'If the extracts do not settle a fact, give null for it.',
  'Call record_terms once.',
].join(' ');

/** Contract-calendar anchors: one obligation of a kind, for one party, should have one deadline against them. */
const SINGLE_DEADLINE_ANCHORS: ReadonlySet<string> = new Set(['term_end', 'term_start', 'effective_date']);

/** Whether two readings put the obligation at the same time. Wording, summary and quote may differ. */
export function sameTiming(a: ObligationRule, b: ObligationRule): boolean {
  const recurrence = (r: ObligationRule['recurrence']) => (r === null ? null : [r.every.count, r.every.unit, r.basis]);
  return (
    a.kind === b.kind &&
    a.anchor === b.anchor &&
    a.offset.count === b.offset.count &&
    a.offset.unit === b.offset.unit &&
    a.offset.direction === b.offset.direction &&
    JSON.stringify(recurrence(a.recurrence)) === JSON.stringify(recurrence(b.recurrence))
  );
}

const loose = (text: string | null): string => (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Groups of obligations that are the same duty (same kind, same party, same
 * contract-calendar anchor) but carry different deadlines. Each group has two
 * or more indices into `rules`.
 */
export function conflictGroups(rules: readonly ObligationRule[]): number[][] {
  const byDuty = new Map<string, number[]>();
  rules.forEach((rule, index) => {
    if (!SINGLE_DEADLINE_ANCHORS.has(rule.anchor)) return;
    const key = [rule.kind, loose(rule.responsibleParty), rule.anchor].join('|');
    byDuty.set(key, [...(byDuty.get(key) ?? []), index]);
  });
  return [...byDuty.values()].filter((group) => {
    const first = rules[group[0] ?? -1];
    return group.length > 1 && first !== undefined && group.some((i) => {
      const other = rules[i];
      return other !== undefined && !sameTiming(first, other);
    });
  });
}

/** The quoted span plus up to `chars` characters either side, taken from the pages it sits on. */
export function contextAround(doc: SourceDocument, match: QuoteMatch, chars: number): string {
  const startIndex = doc.pages.findIndex((p) => p.page === match.pageStart);
  const endIndex = doc.pages.findIndex((p) => p.page === match.pageEnd);
  const first = doc.pages[startIndex];
  const last = doc.pages[endIndex];
  if (!first || !last) return '';
  const before = first.text.slice(Math.max(0, match.startOffset - chars), match.startOffset);
  const after = last.text.slice(match.endOffset, match.endOffset + chars);
  const span =
    startIndex === endIndex
      ? first.text.slice(match.startOffset, match.endOffset)
      : [first.text.slice(match.startOffset), ...doc.pages.slice(startIndex + 1, endIndex).map((p) => p.text), last.text.slice(0, match.endOffset)].join('\n');
  return `${before}${span}${after}`;
}

export function clausePrompt(rule: ObligationRule, context: string): string {
  return [
    `Obligation to check: kind ${rule.kind}, responsible party "${rule.responsibleParty}".`,
    '',
    'Text around the clause:',
    '<excerpt>',
    context,
    '</excerpt>',
  ].join('\n');
}

export function termsPrompt(excerpts: readonly string[]): string {
  return ['Extracts from the contract:', ...excerpts.map((text) => `<excerpt>\n${text}\n</excerpt>`), '', 'Record the effective date, the initial term and the renewal.'].join(
    '\n',
  );
}

type Ask = (request: ToolCallRequest) => Promise<ToolCallResponse>;

export interface QuoteTally {
  returned: number;
  verified: number;
}

export type Reread<T> = { ok: true; value: T; quotes: QuoteTally } | { ok: false; detail: string; quotes: QuoteTally };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const NONE: QuoteTally = { returned: 0, verified: 0 };

/** A fresh reading of one obligation's clause. Fails if the answer is unusable or its quote is not in the contract. */
export async function rereadObligation(
  ask: Ask,
  doc: SourceDocument,
  rule: ObligationRule,
  match: QuoteMatch,
  options: { contextChars: number; minQuoteChars: number },
): Promise<Reread<ObligationRule>> {
  const response = await ask({
    system: CLAUSE_SYSTEM,
    prompt: clausePrompt(rule, contextAround(doc, match, options.contextChars)),
    tool: CLAUSE_TOOL,
    maxOutputTokens: 2000,
  });
  if (response.argumentsJson === null) return { ok: false, detail: 'no tool call', quotes: NONE };
  const json = parseJson(response.argumentsJson);
  if (!json.ok) return { ok: false, detail: 'arguments are not valid JSON', quotes: NONE };
  const parsed = ObligationRuleSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, detail: `invalid rule: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, quotes: NONE };
  const located = locateQuote(parsed.data.quote, doc, parsed.data.page, { minChars: options.minQuoteChars });
  if (located.status === 'rejected') return { ok: false, detail: `quote ${located.reason}`, quotes: { returned: 1, verified: 0 } };
  return { ok: true, value: parsed.data, quotes: { returned: 1, verified: 1 } };
}

/** A fresh reading of the term facts from excerpts around their clauses. Quotes are checked by the caller. */
export async function rereadTerms(ask: Ask, excerpts: readonly string[]): Promise<Reread<TermsReading>> {
  const response = await ask({ system: TERMS_SYSTEM, prompt: termsPrompt(excerpts), tool: TERMS_TOOL, maxOutputTokens: 2000 });
  if (response.argumentsJson === null) return { ok: false, detail: 'no tool call', quotes: NONE };
  const json = parseJson(response.argumentsJson);
  if (!json.ok) return { ok: false, detail: 'arguments are not valid JSON', quotes: NONE };
  const parsed = TermsReadingSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, detail: `invalid terms: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, quotes: NONE };
  return { ok: true, value: parsed.data, quotes: NONE };
}
