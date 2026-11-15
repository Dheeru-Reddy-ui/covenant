import type { ClauseView } from './panel';

/** What the panel shows from the details pass: parties, notices, value and service levels. Types only. */

export type DetailDecisionView = 'pending' | 'confirmed' | 'rejected';

export interface DetailBase {
  id: string;
  clause: ClauseView;
  /** The extractor was unsure, or code could not confirm part of it. The lines say why. */
  needsReview: boolean;
  review: string[];
  decision: DetailDecisionView;
}

export interface PartyView extends DetailBase {
  label: string;
  name: string;
}

export interface AddressView extends DetailBase {
  party: string;
}

export interface MethodView extends DetailBase {
  method: string;
  label: string;
  /** The receipt rule in words. */
  rule: string;
  /** The latest day to send by this method, or null when the contract gives no receipt rule or there is no deadline. */
  latest: string | null;
  steps: string[];
}

export interface ValueView extends DetailBase {
  amountText: string;
  /** The amount as code read it, such as "EUR 120,000". Null when it could not be read with certainty. */
  amount: string | null;
  period: string;
  /** The yearly figure code worked out, when the amount is periodic. */
  yearly: string | null;
  description: string;
}

export interface ServiceLevelView extends DetailBase {
  metric: string;
  summary: string;
  /** Such as "at most 1 incident a month" or "within 4 hours". */
  commitment: string;
  measurable: boolean;
  credit: { clause: ClauseView; terms: string | null } | null;
  claim: { clause: ClauseView; terms: string } | null;
}

export interface DetailsView {
  status: 'none' | 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  /** "7 of 7 quotes found word for word", for a finished pass. */
  grounding: { returned: number; verified: number; rejected: number } | null;
  parties: PartyView[];
  /** The label of the party this site's organisation is, chosen by a person. */
  ourParty: string | null;
  addresses: AddressView[];
  methods: MethodView[];
  /** The notice deadline the send-by dates count back from. */
  deadline: string | null;
  /** The earliest send-by date across the methods. */
  sendBy: string | null;
  values: ValueView[];
  serviceLevels: ServiceLevelView[];
  /** The "Send notice by" work item, once a decision has opened one. */
  noticeItemKey: string | null;
  supplierJql: string;
  defaultJql: string;
}

export interface BreachView {
  /** Identifies the breach within its service level, for opening a claim item. */
  key: string;
  periodLabel: string | null;
  workItems: string[];
  detail: string;
  claimBy: string | null;
  claimOpen: boolean | null;
  claimItemKey: string | null;
}

export interface SupplierRecordView {
  fetchedAtMs: number;
  jql: string;
  /** Work items the filter matched, and how many of them are incidents. */
  matched: number;
  incidents: number;
  term: { number: number; start: string; end: string } | null;
  records: Array<{
    detailId: string;
    summary: string;
    where: string;
    status: 'measured' | 'cannot_measure';
    /** What Jira shows, or why it cannot be measured. */
    observed: string;
    breaches: BreachView[];
    /** The credit code worked out, or null when the formula has to be read by a person. */
    credit: string | null;
    creditNote: string | null;
  }>;
  /** A one-page summary for a renegotiation, shown once that is the decision. Plain lines. */
  leverage: string[] | null;
  problems: string[];
}

export interface NoticeDraftView {
  title: string;
  lines: Array<{ style: 'banner' | 'heading' | 'text' | 'quote' | 'note'; text: string }>;
}
