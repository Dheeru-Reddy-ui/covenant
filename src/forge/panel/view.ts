import {
  type ContractTerms,
  type Duration,
  KIND_LABELS,
  type ReviewNote,
  type ReviewReason,
  type Schedule,
  canApprove,
  currentTermIndex,
  describeSection,
  describeTiming,
  termBounds,
} from '../../../packages/core/src';
import type {
  ClauseView,
  ContractView,
  FactView,
  ObligationView,
  PanelView,
  RunStatusView,
  RunView,
  ScheduleView,
  TermsView,
} from '../../shared/panel';
import { scheduleFor } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { buildBrief } from '../decisions/brief';
import { asUser, getIssue } from '../jira';
import { STALE_RUN_MS } from '../pipeline/start';
import { getLeadDays } from '../settings';
import { undatedText } from '../text';

/** Builds everything the issue panel shows. Dates are worked out fresh on every load, because today moves. */

const REVIEW_TEXT: Record<ReviewReason, string> = {
  passes_disagree: 'A second, independent reading gave a different answer.',
  conflicting_clauses: 'Another clause sets a different deadline for the same duty. Which one wins is your call.',
  conflicting_term_facts: "The contract's term facts contradict each other.",
  second_pass_failed: 'The second reading could not be used, so this was not double-checked.',
  not_rechecked: 'The model was unsure and this was not re-read.',
  date_unreadable: 'The date as written cannot be read with certainty (a blank, a two-digit year, or day/month order).',
  needs_event_date: 'The effective date is an event, such as the last signature. Enter the date.',
};

const reviewLines = (notes: ReviewNote[]): string[] => [...new Set(notes.map((n) => REVIEW_TEXT[n.reason] ?? n.reason))];

const counted = (d: Duration | null): string => (d === null ? '' : `${d.count} ${d.unit.replace('_', ' ')}${d.count === 1 ? '' : 's'}`);

function scheduleView(s: Schedule): ScheduleView {
  if (s.status === 'undated') {
    return { status: 'undated', due: null, later: [], note: undatedText(s.reason, s.detail), trace: [] };
  }
  return { status: s.status, due: s.due, later: s.status === 'upcoming' ? s.later : [], note: null, trace: s.trace };
}

function clauseView(clause: repo.ClauseRow | undefined, paginated: boolean): ClauseView | null {
  if (clause === undefined) return null;
  return {
    quote: clause.quote,
    page: clause.page,
    pageEnd: clause.pageEnd,
    paginated,
    ambiguous: clause.ambiguous,
    section: clause.section ? describeSection(clause.section) : null,
  };
}

function describeSecond(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if ('anchor' in v && 'offset' in v) {
    try {
      return `${String(v.responsibleParty ?? '')}: ${describeTiming(v as never)}`;
    } catch {
      return null;
    }
  }
  if ('dateText' in v || 'event' in v) return String(v.dateText ?? v.event ?? 'not stated');
  if ('kind' in v && ('length' in v || 'endDateText' in v)) {
    if (v.kind === 'until_terminated') return 'runs until terminated';
    const length = v.length as Duration | null;
    return [length ? counted(length) : null, v.endDateText ? `ending ${String(v.endDateText)}` : null].filter(Boolean).join(', ') || String(v.kind);
  }
  if ('automatic' in v) {
    const length = v.length as Duration | null;
    return `${v.automatic ? 'renews automatically' : 'renews only by agreement'}${length ? ` for ${counted(length)}` : ''}`;
  }
  return null;
}

function termsView(terms: ContractTerms | null, autoRenew: boolean, contract: repo.ContractRow, today: string): TermsView | null {
  if (terms === null) return null;
  let currentTerm: TermsView['currentTerm'] = null;
  const index = currentTermIndex(terms, today, { autoRenew, minTermIndex: contract.termIndex });
  if (index.ok) {
    const bounds = termBounds(terms, index.value);
    if (bounds.ok) currentTerm = { number: index.value + 1, start: bounds.value.start, end: bounds.value.end };
  }
  return {
    effectiveDate: terms.effectiveDate,
    initialTerm: terms.initialTerm,
    initialTermEnd: terms.initialTermEnd,
    renewalTerm: terms.renewalTerm,
    autoRenew,
    currentTerm,
  };
}

function factViews(run: repo.RunRow, clauses: Map<string, repo.ClauseRow>): FactView[] {
  const facts = run.facts;
  const t = run.terms;
  if (facts === null || t === null) return [];
  const clause = (id: string | null) => clauseView(id === null ? undefined : clauses.get(id), run.paginated);
  const termText =
    t.initialTerm !== null
      ? `${counted(t.initialTerm)}${t.initialTermEnd ? `, ending ${t.initialTermEnd}` : ''}`
      : t.initialTermEnd !== null
        ? `ends ${t.initialTermEnd}`
        : facts.term.value !== null && (facts.term.value as { kind?: string }).kind === 'until_terminated'
          ? 'runs until terminated'
          : 'not known';
  const renewalText =
    t.renewalTerm !== null
      ? `${run.autoRenew ? 'renews automatically' : 'renews only by decision'}, ${counted(t.renewalTerm)} at a time`
      : facts.renewal.status === 'missing'
        ? 'no renewal clause found'
        : 'does not renew';

  return [
    {
      key: 'effectiveDate',
      label: 'Effective date',
      value: t.effectiveDate ?? 'not known',
      status: facts.effectiveDate.status,
      clause: clause(facts.effectiveDate.clauseId),
      review: reviewLines(facts.effectiveDate.review),
      secondReading: describeSecond(facts.effectiveDate.secondReading),
    },
    {
      key: 'term',
      label: 'Initial term',
      value: termText,
      status: facts.term.status,
      clause: clause(facts.term.clauseId),
      review: reviewLines(facts.term.review),
      secondReading: describeSecond(facts.term.secondReading),
    },
    {
      key: 'renewal',
      label: 'Renewal',
      value: renewalText,
      status: facts.renewal.status,
      clause: clause(facts.renewal.clauseId),
      review: reviewLines(facts.renewal.review),
      secondReading: describeSecond(facts.renewal.secondReading),
    },
  ];
}

/** A run whose worker died shows as failed, so the reviewer knows to click Extract again. */
function effectiveStatus(run: repo.RunRow, nowMs: number): { status: RunStatusView; error: string | null } {
  if (run.status === 'running' && run.startedAtMs !== null && run.startedAtMs < nowMs - STALE_RUN_MS) {
    return { status: 'failed', error: 'The extraction stopped without finishing. Click Extract to try again.' };
  }
  if (run.status === 'queued' && run.queuedAtMs < nowMs - STALE_RUN_MS) {
    return { status: 'failed', error: 'The extraction never started. Click Extract to try again.' };
  }
  return { status: run.status, error: run.errorMessage };
}

interface BriefExtras {
  state: repo.ContractState;
  decisions: repo.DecisionRow[];
  leadDays: number;
}

async function runView(run: repo.RunRow, contract: repo.ContractRow, today: string, nowMs: number, extras: BriefExtras): Promise<RunView> {
  const { status, error } = effectiveStatus(run, nowMs);
  const reviewable = run.status === 'needs_review' || run.status === 'approved';
  const [clauses, obligations] = reviewable ? await Promise.all([repo.listClauses(run.id), repo.listObligations(run.id)]) : [[], []];
  const byId = new Map(clauses.map((c) => [c.id, c]));
  const brief = reviewable ? buildBrief({ contract, run, obligations, clauses: byId, ...extras, today }) : null;

  const views: ObligationView[] = obligations.map((o) => {
    const decided = o.decision === 'approved' || o.decision === 'rejected';
    const schedule = scheduleFor(o.rule, run, contract, o.eventDate, today);
    const view: ObligationView = {
      id: o.id,
      ordinal: o.ordinal,
      kind: o.rule.kind,
      kindLabel: KIND_LABELS[o.rule.kind],
      summary: o.rule.summary,
      party: o.rule.responsibleParty,
      timing: describeTiming(o.rule),
      anchor: o.rule.anchor,
      anchorDescription: o.rule.anchorDescription,
      offset: o.rule.offset,
      recurring: o.rule.recurrence !== null,
      confidence: o.rule.confidence,
      needsReview: o.extractorStatus === 'needs_review' && o.decision === 'pending',
      review: reviewLines(o.review),
      secondReading: o.secondRule === null ? null : describeSecond(o.secondRule),
      clause: clauseView(byId.get(o.clauseId), run.paginated),
      decision: o.decision,
      canApprove: canApprove({ decision: o.decision, extractorStatus: o.extractorStatus }),
      eventDate: o.eventDate,
      // An approved item shows the date its work item was created with.
      schedule:
        decided && o.decision === 'approved'
          ? { status: o.scheduleStatus, due: o.dueDate, later: [], note: o.dueDate === null ? 'Created without a due date.' : null, trace: [] }
          : scheduleView(schedule),
      workItemKey: o.workItemKey,
      lastError: o.lastError,
    };
    return view;
  });

  return {
    id: run.id,
    status,
    errorMessage: error,
    queuedAtMs: run.queuedAtMs,
    startedAtMs: run.startedAtMs,
    finishedAtMs: run.finishedAtMs,
    model: run.model,
    extractorVersion: run.extractorVersion,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    llmCalls: run.llmCalls,
    secondPasses: run.secondPasses,
    quotesReturned: run.quotesReturned,
    quotesVerified: run.quotesVerified,
    rejectedCount: run.rejectedCount,
    pages: run.pages,
    terms: reviewable ? termsView(run.terms, run.autoRenew, contract, today) : null,
    facts: reviewable ? factViews(run, byId) : [],
    obligations: views,
    counts: {
      total: views.length,
      waiting: views.filter((v) => v.decision === 'pending' || v.decision === 'edited' || v.decision === 'approving').length,
      approved: views.filter((v) => v.decision === 'approved').length,
      rejected: views.filter((v) => v.decision === 'rejected').length,
    },
    brief,
  };
}

const SUPPORTED_NAME = /\.(pdf|docx)$/i;

/** `today` is on the viewer's calendar (see todayIn), so the countdown matches theirs. */
export async function loadPanel(issueId: string, today: string): Promise<PanelView> {
  await ensureSchema();
  const [issue, contracts, leadDays] = await Promise.all([getIssue(asUser(), issueId), repo.listContractsForIssue(issueId), getLeadDays()]);
  const nowMs = Date.now();

  const contractViews: ContractView[] = [];
  for (const contract of contracts) {
    const [run, state, decisions] = await Promise.all([
      repo.latestRun(contract.id),
      repo.getContractState(contract.id),
      repo.listDecisionsForContract(contract.id),
    ]);
    contractViews.push({
      id: contract.id,
      fileName: contract.fileName,
      attachmentId: contract.attachmentId,
      termIndex: contract.termIndex,
      createdAtMs: contract.createdAtMs,
      run: run === null ? null : await runView(run, contract, today, nowMs, { state, decisions, leadDays }),
    });
  }

  return {
    issueKey: issue.key,
    today,
    nowMs,
    attachments: issue.attachments.map((a) => ({
      id: a.id,
      fileName: a.filename,
      size: a.size,
      supported: SUPPORTED_NAME.test(a.filename),
      contractId: contracts.find((c) => c.attachmentId === a.id)?.id ?? null,
    })),
    contracts: contractViews,
  };
}
