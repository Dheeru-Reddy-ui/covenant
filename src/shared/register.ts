/** What the register page's resolver sends to the UI. Types only. */

export interface RegisterRowView {
  obligationId: string;
  contractId: string;
  issueKey: string;
  fileName: string;
  kind: string;
  kindLabel: string;
  summary: string;
  party: string;
  timing: string;
  due: string | null;
  daysLeft: number | null;
  scheduleStatus: 'upcoming' | 'past' | 'undated';
  decision: string;
  workItemKey: string | null;
  owner: { accountId: string; displayName: string } | null;
  flags: { noOwner: boolean; insideNoticeWindow: boolean; overdue: boolean };
}

export interface RegisterView {
  today: string;
  windowDays: number | null;
  leadDays: number;
  rows: RegisterRowView[];
  counts: { contracts: number; insideNoticeWindow: number; noOwner: number; overdue: number };
  /** Contracts on work items this person cannot see. They are left out entirely. */
  hiddenContracts: number;
}
