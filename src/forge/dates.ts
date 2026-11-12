import { type IsoDate, type ObligationRule, type Schedule, type ScheduleContext, scheduleRule } from '../../packages/core/src';
import type { ContractRow, RunRow } from './db/repo';

/** Today in UTC. With todayIn, the only places the app reads the clock for dates; core never does. */
export const todayUtc = (): IsoDate => new Date().toISOString().slice(0, 10);

/**
 * Today's date on a person's calendar, so "days left" matches theirs. Used where
 * a person is looking: the panel, the register and the tools. The daily job has
 * no person and stays on UTC. A missing or unknown zone falls back to UTC, and
 * the result says which zone was used.
 */
export function todayIn(timeZone: string | null | undefined, nowMs: number = Date.now()): { today: IsoDate; timeZone: string } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      const [y, m, d] = [part('year'), part('month'), part('day')];
      if (y && m && d && /^\d{4}$/.test(y)) return { today: `${y}-${m}-${d}`, timeZone };
    } catch {
      // An unknown zone: fall through to UTC.
    }
  }
  return { today: new Date(nowMs).toISOString().slice(0, 10), timeZone: 'UTC' };
}

const NO_TERMS = { effectiveDate: null, initialTerm: null, initialTermEnd: null, renewalTerm: null };

/** When an obligation is next due, from the run's confirmed term facts and the contract's current term. */
export function scheduleFor(rule: ObligationRule, run: RunRow, contract: ContractRow, eventDate: IsoDate | null, today: IsoDate): Schedule {
  const ctx: ScheduleContext = {
    terms: run.terms ?? NO_TERMS,
    today,
    autoRenew: run.autoRenew,
    minTermIndex: contract.termIndex,
    eventDate,
  };
  return scheduleRule(rule, ctx);
}

export const dueDateOf = (s: Schedule): IsoDate | null => (s.status === 'undated' ? null : s.due);
