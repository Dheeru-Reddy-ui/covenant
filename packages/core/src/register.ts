import { type IsoDate, addMonths, compareDates, diffDays, startOfMonth, yearMonth } from './dates/civil';
import { type CurrencyTotal, type Money, totalByCurrency } from './money';
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

export interface ContractLoad {
  /** The contract's next notice deadline, or null when it has none dated. */
  deadline: IsoDate | null;
  /** True when the contract renews by itself unless notice is given. */
  autoRenew: boolean;
  /** The contract's yearly value, only when a person has confirmed it. */
  yearly: Money | null;
}

export interface LoadMonth {
  /** YYYY-MM. */
  month: string;
  label: string;
  deadlines: number;
  values: CurrencyTotal[];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Notice deadlines and confirmed value per month, from this month for `months` months. Code does the sums. */
export function renewalLoad(contracts: readonly ContractLoad[], today: IsoDate, months = 12): LoadMonth[] {
  const out: LoadMonth[] = [];
  const first = startOfMonth(today);
  for (let i = 0; i < months; i += 1) {
    const start = addMonths(first, i);
    const { year, month } = yearMonth(start);
    const key = start.slice(0, 7);
    const inMonth = contracts.filter((c) => c.deadline !== null && c.deadline.slice(0, 7) === key && compareDates(c.deadline, today) >= 0);
    out.push({
      month: key,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      deadlines: inMonth.length,
      values: totalByCurrency(inMonth.flatMap((c) => (c.yearly ? [c.yearly] : []))),
    });
  }
  return out;
}

/**
 * Money at stake: the confirmed yearly value of contracts that will renew by
 * themselves unless notice is given within `days`. Contracts in the window
 * with no confirmed value are counted, never estimated.
 */
export function moneyAtStake(contracts: readonly ContractLoad[], today: IsoDate, days: number): { totals: CurrencyTotal[]; contracts: number; unvalued: number } {
  const inWindow = contracts.filter((c) => {
    if (!c.autoRenew || c.deadline === null) return false;
    const left = diffDays(today, c.deadline);
    return left >= 0 && left <= days;
  });
  return {
    totals: totalByCurrency(inWindow.flatMap((c) => (c.yearly ? [c.yearly] : []))),
    contracts: inWindow.length,
    unvalued: inWindow.filter((c) => c.yearly === null).length,
  };
}
