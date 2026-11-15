/** What the panel shows on an obligation's own work item: the evidence check. Types only. */

import type { ClauseView } from './panel';

export type EvidenceVerdictView = 'pass' | 'fail' | 'needs_review';

export interface EvidenceFindingView {
  requirement: string;
  result: 'met' | 'not_met' | 'not_shown';
  /** Words of the contract clause. */
  clauseQuote: string;
  /** Words of the document, or null when it does not mention the requirement. */
  evidenceQuote: string | null;
  evidencePage: number | null;
  /** Why a person should look at this finding, in plain words. */
  notes: string[];
}

export interface EvidenceCheckView {
  id: string;
  attachmentId: string;
  fileName: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  verdict: EvidenceVerdictView | null;
  documentKind: string | null;
  findings: EvidenceFindingView[];
  expiry: { dateText: string; quote: string; page: number; date: string | null; requiredUntil: string; expired: boolean | null } | null;
  party: { nameText: string; quote: string; page: number; expected: string | null; matches: boolean | null } | null;
  /** Why the verdict is what it is, in plain words. */
  reasons: string[];
  /** The drafted chase message, line by line. Empty unless the check failed. */
  chase: string[];
  error: string | null;
  /** 'panel' when a person clicked Check, 'attachment' when Covenant saw the file arrive. */
  source: string;
  finishedAtMs: number | null;
  /** The chase draft was added to the work item as a comment. */
  commented: boolean;
  /** False for Word files: their quotes have no page. */
  paginated: boolean;
}

export interface EvidenceView {
  obligationId: string;
  kindLabel: string;
  summary: string;
  party: string;
  /** Where the obligation came from: the contract's work item. */
  contractKey: string;
  contractId: string;
  contractFile: string;
  clause: ClauseView | null;
  /** Insurance certificates and reports: the kinds where the other party owes a document. Others can still be checked. */
  expectsDocument: boolean;
  /** The last day a document must be valid through, when Covenant can tell. */
  requiredUntil: string | null;
  /** The party the clause binds, by name, when the details pass found it. */
  expectedParty: string | null;
  /** A sample workspace contract: the panel offers two invented certificates to try the check with. */
  sampleCertificates: boolean;
  attachments: Array<{ id: string; fileName: string; supported: boolean; tooLarge: boolean; check: EvidenceCheckView | null }>;
}
