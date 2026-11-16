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
  /** The work item is done in Jira. With flags.done false, it finished an earlier date of a recurring duty. */
  workItemDone: boolean;
  owner: { accountId: string; displayName: string } | null;
  /** done: the work item for the date shown is done, so the row is never overdue or ownerless. */
  flags: { noOwner: boolean; insideNoticeWindow: boolean; overdue: boolean; done: boolean };
  /** For a notice deadline: the decision recorded for its term, such as "Renew". Null while one is still needed. */
  decided: string | null;
}

export interface RegisterView {
  today: string;
  windowDays: number | null;
  leadDays: number;
  rows: RegisterRowView[];
  /** insideNoticeWindow counts deadlines still waiting for a decision; decided counts those already settled. */
  counts: { contracts: number; insideNoticeWindow: number; decided: number; noOwner: number; overdue: number };
  /** Contracts on work items this person cannot see. They are left out entirely. */
  hiddenContracts: number;
  /** Money at stake: the confirmed yearly value of contracts that renew by themselves unless notice is given in the next `days`. */
  money: { days: number; totals: string[]; contracts: number; unvalued: number; valuesAwaiting: number };
  /** Notice deadlines per month for the next twelve months, with confirmed value per currency in major units. */
  load: Array<{ label: string; deadlines: number; values: Array<{ currency: string; amount: number }> }>;
}
