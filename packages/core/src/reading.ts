import { z } from 'zod';
import { ConfidenceSchema, DurationSchema, ObligationRuleSchema, PageHintSchema, QuoteSchema } from './schema';

/**
 * What the model reports about one whole contract: the three term facts the
 * date engine needs, and the obligations as rules. Dates appear only as text
 * copied from inside a quote; code parses them (dates/written.ts).
 */

const DateTextSchema = z.string().min(1).max(80);

export const EffectiveDateReadingSchema = z
  .strictObject({
    dateText: DateTextSchema.nullable().describe(
      'The effective date exactly as written, for example "March 1, 2025" or "the 1st day of March, 2025", copied from inside the quote. ' +
        'null when the contract makes the effective date an event, such as the date of the last signature, instead of writing a date.',
    ),
    event: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .describe('Only when dateText is null: the event that sets the effective date, in a few words. Otherwise null.'),
    quote: QuoteSchema,
    page: PageHintSchema,
    confidence: ConfidenceSchema,
  })
  .superRefine((r, ctx) => {
    if ((r.dateText === null) === (r.event === null)) {
      ctx.addIssue({ code: 'custom', path: ['dateText'], message: 'give exactly one of dateText and event' });
    }
  });

export const TermReadingSchema = z
  .strictObject({
    kind: z
      .enum(['fixed_length', 'fixed_end_date', 'until_terminated'])
      .describe(
        'fixed_length: the initial term runs for a stated length. fixed_end_date: it ends on a stated date. ' +
          'until_terminated: it has no set end and continues until a party ends it.',
      ),
    length: DurationSchema.nullable().describe('The length of the initial term, as the text states it. Required for fixed_length; null otherwise.'),
    endDateText: DateTextSchema.nullable().describe(
      'The date the initial term ends, exactly as written inside the quote. Required for fixed_end_date; allowed with fixed_length when the text states both; otherwise null.',
    ),
    quote: QuoteSchema,
    page: PageHintSchema,
    confidence: ConfidenceSchema,
  })
  .superRefine((t, ctx) => {
    if (t.kind === 'fixed_length' && t.length === null) {
      ctx.addIssue({ code: 'custom', path: ['length'], message: 'fixed_length needs a length' });
    }
    if (t.kind === 'fixed_end_date' && (t.endDateText === null || t.length !== null)) {
      ctx.addIssue({ code: 'custom', path: ['endDateText'], message: 'fixed_end_date needs endDateText and no length' });
    }
    if (t.kind === 'until_terminated' && (t.length !== null || t.endDateText !== null)) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'until_terminated has no length and no end date' });
    }
  });

export const RenewalReadingSchema = z.strictObject({
  automatic: z
    .boolean()
    .describe('true when the contract renews by itself unless someone gives notice; false when renewal needs both parties to agree or an option to be exercised.'),
  length: DurationSchema.nullable().describe('The length of each renewal term as the text states it, or null if it does not say.'),
  quote: QuoteSchema,
  page: PageHintSchema,
  confidence: ConfidenceSchema,
});

const termsShape = {
  effectiveDate: EffectiveDateReadingSchema.nullable().describe(
    'When the agreement takes effect. If it is effective as of the date written at its start, quote the sentence where that date is written. null if the text never says.',
  ),
  term: TermReadingSchema.nullable().describe('How long the initial term lasts. null if the text never says.'),
  renewal: RenewalReadingSchema.nullable().describe('How the agreement renews. null when the text says nothing about renewal.'),
};

export const ContractReadingSchema = z.strictObject({
  ...termsShape,
  obligations: z
    .array(ObligationRuleSchema)
    .max(80)
    .describe(
      'Every obligation of the six kinds that has a deadline or a recurring due date, each recorded once. ' +
        'Notice of non-renewal or termination tied to the end of the term is renewal_notice with anchor term_end.',
    ),
});

/**
 * The same envelope with each fact and obligation left unchecked, so one bad
 * item is dropped on its own instead of sinking the whole reading.
 */
export const ContractReadingEnvelopeSchema = z.strictObject({
  effectiveDate: z.unknown(),
  term: z.unknown(),
  renewal: z.unknown(),
  obligations: z.array(z.unknown()).max(80),
});

/** Just the term facts: what the second pass re-reads when one of them is in doubt. */
export const TermsReadingSchema = z.strictObject(termsShape);

export type EffectiveDateReading = z.infer<typeof EffectiveDateReadingSchema>;
export type TermReading = z.infer<typeof TermReadingSchema>;
export type RenewalReading = z.infer<typeof RenewalReadingSchema>;
export type ContractReading = z.infer<typeof ContractReadingSchema>;
export type TermsReading = z.infer<typeof TermsReadingSchema>;

/** JSON Schema for an LLM tool's parameters, without the `$schema` key some providers reject. */
export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
