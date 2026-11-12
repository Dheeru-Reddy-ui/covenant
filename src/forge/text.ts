import type { TermProblem, UnresolvedReason } from '../../packages/core/src';

/** Plain-English reasons shown to reviewers. They name facts and fixes, never contract text. */

export const UNDATED_TEXT: Partial<Record<UnresolvedReason, string>> = {
  needs_event_date: 'It runs from an event. Enter the event date with Edit to get a due date.',
  needs_fiscal_year: 'It follows a fiscal year the contract does not define.',
  missing_effective_date: 'The effective date is not confirmed. Set it under Contract terms.',
  missing_initial_term: 'The length of the initial term is not confirmed. Set it under Contract terms.',
  conflicting_term_facts: "The contract's term facts contradict each other. Fix them under Contract terms.",
  unsupported_term_unit: 'The term is measured in business days, which Covenant does not roll forward.',
};

export const undatedText = (reason: UnresolvedReason, detail: string): string => UNDATED_TEXT[reason] ?? `No date: ${detail}.`;

export const ROLLOVER_BLOCKED_TEXT: Partial<Record<TermProblem, string>> = {
  no_renewal_term: 'The contract has no renewal term, so it cannot be marked renewed. Record a decision to renegotiate or end it instead.',
  missing_effective_date: 'Set the effective date under Contract terms before marking the contract renewed.',
  missing_initial_term: 'Set the initial term under Contract terms before marking the contract renewed.',
  conflicting_term_facts: "Fix the contract's term facts under Contract terms first: they contradict each other.",
};

export const OUTCOME_LABELS: Record<string, string> = {
  renew: 'Renew',
  renegotiate: 'Renegotiate',
  terminate: 'Terminate',
};
