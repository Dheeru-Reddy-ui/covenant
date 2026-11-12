import { type IsoDate, type ObligationRule, type Schedule, type ScheduleContext, scheduleRule } from '../../packages/core/src';
import type { ContractRow, RunRow } from './db/repo';

/** Today in UTC. The only place the app reads the clock for dates; core never does. */
export const todayUtc = (): IsoDate => new Date().toISOString().slice(0, 10);

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
