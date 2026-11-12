/**
 * @covenant/core: schema, verifier, date engine, extractor and critic.
 *
 * Pure TypeScript. Nothing here imports Forge, Node or browser APIs, reads the
 * clock, or logs, so the same code runs under tests, in the eval harness and
 * inside Forge. Model calls go through the LlmClient interface; the adapters
 * live with their platforms.
 */

export const CORE_VERSION = '0.2.0';

export * from './dates/civil';
export * from './dates/business';
export * from './dates/terms';
export * from './dates/resolve';
export * from './dates/written';
export * from './verify';
export * from './llm';
export * from './reading';
export * from './critic';
export * from './extract';
export {
  AnchorEventSchema,
  ClauseSchema,
  ConfidenceSchema,
  ContractTermsSchema,
  DurationSchema,
  DurationUnitSchema,
  OBLIGATION_KINDS,
  ObligationKindSchema,
  ObligationRuleSchema,
  OffsetSchema,
  PageHintSchema,
  QuoteSchema,
  RecurrenceSchema,
  SCHEMA_VERSION,
  obligationRuleJsonSchema,
} from './schema';
export type { Clause, ObligationKind, ObligationRule } from './schema';
