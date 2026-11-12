import { type IsoDate, compareDates, diffDays } from './dates/civil';
import type { ObligationDecision } from './review';

/** The portfolio register: every obligation by due date, with the flags a contract owner scans for. */

export const REGISTER_WINDOWS = [30, 60, 90] as const;

export interface RegisterItem {
  kind: string;
  due: IsoDate | null;
  scheduleStatus: 'upcoming' | 'past' | 'undated';
  /** Someone is responsible: the obligation has a work item with an assignee. */
  hasOwner: boolean;
  decision: ObligationDecision;
}

export interface RegisterOptions {
  today: IsoDate;
  /** Only items due from today to this many days ahead. Null shows everything, including past and undated items. */
  windowDays: number | null;
  /** A renewal notice due within this many days is inside its decision window. */
  noticeLeadDays: number;
}

export type RegisterRow<T extends RegisterItem> = T & {
  daysLeft: number | null;
  flags: { noOwner: boolean; insideNoticeWindow: boolean; overdue: boolean };
};

export function registerRows<T extends RegisterItem>(items: readonly T[], options: RegisterOptions): Array<RegisterRow<T>> {
  const rows = items
    .filter((item) => item.decision !== 'rejected')
    .map((item): RegisterRow<T> => {
      const daysLeft = item.due === null ? null : diffDays(options.today, item.due);
      return {
        ...item,
        daysLeft,
        flags: {
          noOwner: !item.hasOwner,
          insideNoticeWindow: item.kind === 'renewal_notice' && daysLeft !== null && daysLeft >= 0 && daysLeft <= options.noticeLeadDays,
          overdue: daysLeft !== null && daysLeft < 0,
        },
      };
    })
    .filter((row) => {
      if (options.windowDays === null) return true;
      return row.daysLeft !== null && row.daysLeft >= 0 && row.daysLeft <= options.windowDays;
    });

  return rows.sort((a, b) => {
    if (a.due === null) return b.due === null ? 0 : 1;
    if (b.due === null) return -1;
    return compareDates(a.due, b.due);
  });
}
