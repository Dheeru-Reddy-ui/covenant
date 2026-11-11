import { z } from 'zod';
import { isValidIsoDate } from './dates/civil';
import type { RuleTiming } from './dates/resolve';
import type { ContractTerms as EngineContractTerms } from './dates/terms';

/**
 * Bump when the rule shape or its meaning changes. A run is keyed on the
 * attachment hash plus this version, so a bump forces a fresh extraction.
 */
export const SCHEMA_VERSION = 1;

/** The six obligation types in scope. */
export const OBLIGATION_KINDS = [
  'renewal_notice', // notice to renew, not renew, or terminate
  'payment',
  'price_change',
  'reporting_deliverable',
  'audit_insurance', // audit rights, insurance certificates
  'service_credit',
] as const;

export const ObligationKindSchema = z.enum(OBLIGATION_KINDS);
export type ObligationKind = z.infer<typeof ObligationKindSchema>;

export const DurationUnitSchema = z.enum(['day', 'business_day', 'week', 'month', 'year']);

export const DurationSchema = z.strictObject({
  count: z.int().min(1).max(10_000),
  unit: DurationUnitSchema,
});

/**
 * How far from the anchor, and which way. This is all the model may say about
 * timing: a count, a unit and a direction. There is deliberately no date field.
 */
export const OffsetSchema = z
  .strictObject({
    count: z.int().min(0).max(10_000),
    unit: DurationUnitSchema,
    direction: z.enum(['before', 'after', 'on']),
  })
  .refine((o) => (o.direction === 'on' ? o.count === 0 : o.count >= 1), {
    message: '"on" needs a count of 0; "before" and "after" need a count of at least 1',
  });

export const AnchorEventSchema = z.enum([
  'effective_date',
  'term_start',
  'term_end',
  'period_start',
  'period_end',
  'anniversary',
  'event',
]);

export const RecurrenceSchema = z.strictObject({
  every: z.strictObject({
    count: z.int().min(1).max(120),
    unit: z.enum(['week', 'month', 'quarter', 'year']),
  }),
  basis: z.enum(['calendar', 'contract', 'fiscal']),
});

const RECURRING_ANCHORS: ReadonlySet<string> = new Set(['period_start', 'period_end', 'anniversary']);

/**
 * One obligation as the model reports it: what must happen, who must do it,
 * and when, expressed as a rule. The model reads; code decides the date.
 */
export const ObligationRuleSchema = z
  .strictObject({
    kind: ObligationKindSchema.describe(
      'renewal_notice: notice to renew, not renew or terminate. payment: paying an invoice or fee. price_change: notice of a fee change. ' +
        'reporting_deliverable: a report or deliverable owed. audit_insurance: audit rights or insurance certificates. service_credit: claiming a service credit.',
    ),
    responsibleParty: z
      .string()
      .min(1)
      .max(120)
      .describe('The party that must act, using the label the contract uses, for example "Customer" or "Supplier". "Either party" is allowed.'),
    summary: z.string().min(1).max(300).describe('One plain sentence saying what must be done. No dates.'),
    anchor: AnchorEventSchema.describe(
      'What the deadline is measured from. term_end and term_start mean the current term: renewals are handled by rolling the term forward, ' +
        'so a deadline before the end of each renewed term is still just term_end with no recurrence. ' +
        'period_start and period_end mean each recurring period (each month, quarter or year) and need a recurrence. ' +
        'anniversary means each anniversary of the effective date and needs a yearly recurrence on the contract basis. ' +
        'event means something outside the contract calendar, such as receipt of an invoice.',
    ),
    anchorDescription: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .describe('Required when anchor is "event": the event in a few words, for example "date of the invoice". Otherwise null.'),
    offset: OffsetSchema.describe(
      'How far from the anchor and which way, exactly as the text says. "on" needs count 0. "within 30 days after" is count 30, unit day, direction after. ' +
        'Use business_day only when the text says business or working days.',
    ),
    recurrence: RecurrenceSchema.nullable().describe(
      'Must be null unless anchor is period_start, period_end or anniversary. Must be null for term_end, term_start, effective_date and event, ' +
        'even when the contract renews: the date engine rolls the term forward itself. ' +
        'basis is "calendar" for calendar months, quarters and years, "contract" for periods counted from the effective date, "fiscal" for a fiscal year.',
    ),
    quote: z
      .string()
      .min(1)
      .max(4000)
      .describe('The sentence or clause this rule comes from, copied character for character from the text. Do not paraphrase, shorten words or fix typos.'),
    page: z.int().min(1).nullable().describe('The page the quote appears on, if the text shows page numbers. Otherwise null. Used only as a hint.'),
    confidence: z
      .enum(['high', 'medium', 'low'])
      .describe('high when the text states every part of the rule; medium when one part is implied; low when the wording is unclear or conflicts with another clause.'),
  })
  .superRefine((rule, ctx) => {
    const recurring = RECURRING_ANCHORS.has(rule.anchor);
    if (recurring && rule.recurrence === null) {
      ctx.addIssue({ code: 'custom', path: ['recurrence'], message: `anchor "${rule.anchor}" needs a recurrence` });
    }
    if (!recurring && rule.recurrence !== null) {
      ctx.addIssue({ code: 'custom', path: ['recurrence'], message: `anchor "${rule.anchor}" cannot recur` });
    }
    if (rule.anchor === 'anniversary' && rule.recurrence !== null && rule.recurrence.basis !== 'contract') {
      ctx.addIssue({ code: 'custom', path: ['recurrence', 'basis'], message: 'anniversaries use the "contract" basis' });
    }
    if (rule.anchor === 'event' && rule.anchorDescription === null) {
      ctx.addIssue({ code: 'custom', path: ['anchorDescription'], message: 'an "event" anchor needs a description' });
    }
  });

export type ObligationRule = z.infer<typeof ObligationRuleSchema>;

/** A span of contract text that code has located in the source document. */
export const ClauseSchema = z
  .strictObject({
    id: z.string().min(1),
    heading: z.string().min(1).max(300).nullable(),
    quote: z.string().min(1),
    pageStart: z.int().min(1),
    pageEnd: z.int().min(1),
  })
  .refine((c) => c.pageStart <= c.pageEnd, { message: 'pageStart must not be after pageEnd' });

export type Clause = z.infer<typeof ClauseSchema>;

const IsoDateSchema = z.string().refine(isValidIsoDate, { message: 'must be a real date written YYYY-MM-DD' });

/** The term facts the date engine resolves against. `null` means not known. */
export const ContractTermsSchema = z.strictObject({
  effectiveDate: IsoDateSchema.nullable(),
  initialTerm: DurationSchema.nullable(),
  initialTermEnd: IsoDateSchema.nullable(),
  renewalTerm: DurationSchema.nullable(),
});

export type ContractTerms = z.infer<typeof ContractTermsSchema>;

/** JSON Schema for one rule, for use as an LLM tool's parameter schema. Cross-field rules are enforced by parsing, not by this schema. */
export function obligationRuleJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ObligationRuleSchema) as Record<string, unknown>;
}

// Compile-time proof that what the schema accepts is what the date engine takes.
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
export type _RuleFeedsEngine = Assert<Extends<ObligationRule, RuleTiming>>;
export type _TermsFeedEngine = Assert<Extends<ContractTerms, EngineContractTerms>>;
