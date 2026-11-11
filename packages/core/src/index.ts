/**
 * @covenant/core: schema, verifier and date engine.
 *
 * Pure TypeScript. Nothing here imports Forge, Node or browser APIs, reads the
 * clock, or logs, so the same code runs under tests, in the eval harness and
 * inside Forge.
 */

export const CORE_VERSION = '0.1.0';

export * from './dates/civil';
export * from './dates/business';
export * from './dates/terms';
export * from './dates/resolve';
export * from './verify';
export {
  AnchorEventSchema,
  ClauseSchema,
  ContractTermsSchema,
  DurationSchema,
  DurationUnitSchema,
  OBLIGATION_KINDS,
  ObligationKindSchema,
  ObligationRuleSchema,
  OffsetSchema,
  RecurrenceSchema,
  SCHEMA_VERSION,
  obligationRuleJsonSchema,
} from './schema';
export type { Clause, ObligationKind, ObligationRule } from './schema';
