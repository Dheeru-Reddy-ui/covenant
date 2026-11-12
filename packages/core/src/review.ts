import { type ContractTerms, termBounds } from './dates/terms';
import type { FactStatus } from './extract';
import { ContractTermsSchema, type ObligationRule, ObligationRuleSchema } from './schema';

/**
 * The human review step. Nothing reaches Jira until a person approves it, and a
 * person's edit changes what the rule says, never the quote it rests on.
 */

/** Where one obligation is in review. 'approving' is held while its work item is being created. */
export type ObligationDecision = 'pending' | 'edited' | 'approving' | 'approved' | 'rejected';

/** The parts of a rule a reviewer may change. The quote, page hint and model confidence are evidence and stay as read. */
export interface ObligationEdit {
  kind?: ObligationRule['kind'];
  responsibleParty?: string;
  summary?: string;
  anchor?: ObligationRule['anchor'];
  anchorDescription?: string | null;
  offset?: ObligationRule['offset'];
}

export type EditResult = { ok: true; rule: ObligationRule } | { ok: false; problems: string[] };

const problemsOf = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string[] =>
  issues.map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message));

export function applyObligationEdit(rule: ObligationRule, edit: ObligationEdit): EditResult {
  const next: Record<string, unknown> = { ...rule };
  if (edit.kind !== undefined) next.kind = edit.kind;
  if (edit.responsibleParty !== undefined) next.responsibleParty = edit.responsibleParty.trim();
  if (edit.summary !== undefined) next.summary = edit.summary.trim();
  if (edit.offset !== undefined) next.offset = { ...edit.offset };
  if (edit.anchor !== undefined) next.anchor = edit.anchor;
  if (edit.anchorDescription !== undefined) {
    const text = edit.anchorDescription?.trim() ?? '';
    next.anchorDescription = text.length > 0 ? text : null;
  }
  // An event description only means something for an event anchor.
  if (next.anchor !== 'event') next.anchorDescription = null;

  const parsed = ObligationRuleSchema.safeParse(next);
  return parsed.success ? { ok: true, rule: parsed.data } : { ok: false, problems: problemsOf(parsed.error.issues) };
}

/**
 * A rule the extractor marked "needs review" cannot be approved as read: a
 * person must open it and save it first, which records that they decided.
 */
export function canApprove(item: { decision: ObligationDecision; extractorStatus: FactStatus }): boolean {
  if (item.decision === 'edited') return true;
  return item.decision === 'pending' && item.extractorStatus === 'ready';
}

/** A run is approved once every obligation in it has been approved or rejected. */
export function runReviewStatus(decisions: readonly ObligationDecision[]): 'needs_review' | 'approved' {
  if (decisions.length === 0) return 'needs_review';
  return decisions.every((d) => d === 'approved' || d === 'rejected') ? 'approved' : 'needs_review';
}

export type TermsEditResult = { ok: true; terms: ContractTerms } | { ok: false; problems: string[] };

/** Term facts a person typed in. Unknown is fine; contradictory or impossible is not. */
export function parseTermsEdit(input: unknown): TermsEditResult {
  const parsed = ContractTermsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problems: problemsOf(parsed.error.issues) };
  const terms = parsed.data;
  if (terms.effectiveDate !== null && (terms.initialTerm !== null || terms.initialTermEnd !== null)) {
    const first = termBounds(terms, 0);
    if (!first.ok) return { ok: false, problems: [first.detail] };
    if (terms.renewalTerm !== null) {
      const renewal = termBounds(terms, 1);
      if (!renewal.ok) return { ok: false, problems: [renewal.detail] };
    }
  }
  return { ok: true, terms };
}
