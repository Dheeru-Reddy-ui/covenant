import { DEFAULT_DECISION_LEAD_DAYS, MAX_DECISION_LEAD_DAYS, MIN_DECISION_LEAD_DAYS } from '../../packages/core/src';
import * as repo from './db/repo';
import { UserFacingError } from './errors';

/** Site-wide settings, kept in the app_setting table. */

const LEAD_DAYS = 'decision_lead_days';
export const DAILY_LAST_RUN = 'daily_last_run';
export const SAMPLE_WORKSPACE = 'sample_workspace';

export async function getLeadDays(): Promise<number> {
  const stored = Number(await repo.getSetting(LEAD_DAYS));
  return Number.isInteger(stored) && stored >= MIN_DECISION_LEAD_DAYS && stored <= MAX_DECISION_LEAD_DAYS ? stored : DEFAULT_DECISION_LEAD_DAYS;
}

export async function setLeadDays(days: number, accountId: string): Promise<void> {
  if (!Number.isInteger(days) || days < MIN_DECISION_LEAD_DAYS || days > MAX_DECISION_LEAD_DAYS) {
    throw new UserFacingError(`The lead time must be a whole number of days from ${MIN_DECISION_LEAD_DAYS} to ${MAX_DECISION_LEAD_DAYS}.`);
  }
  await repo.putSetting(LEAD_DAYS, String(days), accountId, Date.now());
}

export async function getJson<T>(name: string): Promise<T | null> {
  const text = await repo.getSetting(name);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function putJson(name: string, value: unknown, accountId: string | null): Promise<void> {
  await repo.putSetting(name, JSON.stringify(value), accountId, Date.now());
}
