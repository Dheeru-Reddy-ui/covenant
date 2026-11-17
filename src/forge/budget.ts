import * as repo from './db/repo';
import { UserFacingError } from './errors';

/**
 * Model tokens are billed to the app's developer, so each site may ask for at
 * most this many document readings (extractions, details passes and evidence
 * checks) in any 24 hours. Setting up the sample workspace uses six. Clicking
 * again on a file already read costs nothing and is never counted.
 */
export const DAILY_MODEL_JOBS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function requireModelBudget(nowMs: number = Date.now()): Promise<void> {
  const used = await repo.countModelJobsSince(nowMs - DAY_MS);
  if (used < DAILY_MODEL_JOBS) return;
  console.log(`model budget reached used=${used} limit=${DAILY_MODEL_JOBS}`);
  throw new UserFacingError(
    `This site has asked Covenant to read ${used} documents in the last 24 hours, which is as many as it reads in a day. Try again tomorrow; nothing already read is lost.`,
  );
}
