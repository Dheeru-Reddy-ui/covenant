/**
 * What the issue panel's resolvers send to the UI. Shared by both sides, so it
 * holds types only: the frontend bundle must not pull in server code.
 */

export type RunStatusView = 'queued' | 'running' | 'needs_review' | 'approved' | 'failed';
export type DecisionView = 'pending' | 'edited' | 'approving' | 'approved' | 'rejected';
export type FactStateView = 'ready' | 'needs_review' | 'missing' | 'edited';

export interface DurationView {
  count: number;
  unit: string;
}

export interface OffsetView {
  count: number;
  unit: string;
  direction: 'before' | 'after' | 'on';
}

export interface AttachmentView {
  id: string;
  fileName: string;
  size: number;
  /** PDF or DOCX by name. The file's first bytes decide for certain when Extract is clicked. */
  supported: boolean;
  contractId: string | null;
}

export interface ClauseView {
  quote: string;
  page: number;
  pageEnd: number;
  /** False for Word files, which have no fixed pages. */
  paginated: boolean;
  /** The quote appears more than once and Covenant could not tell which one is meant. */
  ambiguous: boolean;
}

export interface FactView {
  key: 'effectiveDate' | 'term' | 'renewal';
  label: string;
  value: string;
  status: FactStateView;
  clause: ClauseView | null;
  review: string[];
  secondReading: string | null;
}

export interface TermsView {
  effectiveDate: string | null;
  initialTerm: DurationView | null;
  initialTermEnd: string | null;
  renewalTerm: DurationView | null;
  autoRenew: boolean;
  currentTerm: { number: number; start: string; end: string } | null;
}

export interface ScheduleView {
  status: 'upcoming' | 'past' | 'undated';
  due: string | null;
  later: string[];
  /** Why there is no date, in plain words. */
  note: string | null;
  trace: string[];
}

export interface ObligationView {
  id: string;
  ordinal: number;
  kind: string;
  kindLabel: string;
  summary: string;
  party: string;
  timing: string;
  anchor: string;
  anchorDescription: string | null;
  offset: OffsetView;
  recurring: boolean;
  confidence: 'high' | 'medium' | 'low';
  needsReview: boolean;
  review: string[];
  secondReading: string | null;
  clause: ClauseView | null;
  decision: DecisionView;
  canApprove: boolean;
  eventDate: string | null;
  schedule: ScheduleView;
  workItemKey: string | null;
  lastError: string | null;
}

export type WindowStatusView = 'no_notice_rule' | 'undated' | 'later' | 'due' | 'passed';

export interface DecisionRecordView {
  id: string;
  outcome: string;
  outcomeLabel: string;
  rationale: string;
  termNumber: number;
  decidedBy: string;
  decidedAtMs: number;
}

export interface BriefView {
  window: {
    status: WindowStatusView;
    deadline: string | null;
    daysLeft: number | null;
    decisionOpensOn: string | null;
    termEnd: string | null;
    timing: string | null;
    note: string | null;
  };
  leadDays: number;
  autoRenew: boolean;
  termNumber: number;
  currentTerm: { start: string; end: string } | null;
  nextTerm: { number: number; start: string; end: string } | null;
  /** Why the contract cannot be marked renewed, when it cannot. */
  rolloverBlocked: string | null;
  canUndoRenewal: boolean;
  renewedAtMs: number | null;
  clauses: Array<{ label: string; clause: ClauseView }>;
  decisionItemKey: string | null;
  decisions: DecisionRecordView[];
  /** What marking the contract renewed would move, before and after. Only dates that change. */
  shifts: Array<{ obligationId: string; label: string; before: string | null; after: string | null }>;
  /** Approved work items whose due date no longer matches the contract, for example after a renewal. */
  staleWorkItems: Array<{ obligationId: string; workItemKey: string; stored: string | null; current: string | null }>;
}

/** Context for a decision brief, loaded only when a person opens it, as that person. */
export interface ContextView {
  fetchedAtMs: number;
  cached: boolean;
  related: Array<{ key: string; summary: string; type: string; status: string; assignee: string | null; incident: boolean; viaCovenant: boolean }>;
  goals: Array<{ name: string; key: string | null; url: string | null; due: string | null; owner: string | null }>;
  teams: Array<{ name: string; url: string | null; members: number }>;
  owners: Array<{ accountId: string; name: string | null; score: number; evidence: string[] }>;
  /** Sections that could not be loaded. Missing data is said out loud, never shown as "none". */
  problems: string[];
}

export interface RunView {
  id: string;
  status: RunStatusView;
  errorMessage: string | null;
  queuedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  model: string;
  extractorVersion: number;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  secondPasses: number;
  quotesReturned: number;
  quotesVerified: number;
  rejectedCount: number;
  pages: number | null;
  terms: TermsView | null;
  facts: FactView[];
  obligations: ObligationView[];
  counts: { total: number; waiting: number; approved: number; rejected: number };
  brief: BriefView | null;
}

export interface ContractView {
  id: string;
  fileName: string;
  attachmentId: string;
  /** The term a person has marked the contract renewed into. 0 is the initial term. */
  termIndex: number;
  createdAtMs: number;
  run: RunView | null;
}

export interface PanelView {
  issueKey: string;
  today: string;
  nowMs: number;
  attachments: AttachmentView[];
  contracts: ContractView[];
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface StartReply {
  contractId: string;
  runId: string;
  outcome: 'queued' | 'requeued' | 'existing';
  status: RunStatusView;
}

export interface ApproveReply {
  workItemKey: string;
  dueDate: string | null;
  dueDateSet: boolean;
}
