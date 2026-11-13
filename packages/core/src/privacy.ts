/**
 * Personal data rules. Covenant stores the Atlassian account ids of the people
 * who extract, approve, decide, renew or change settings, and reports them each
 * week through Atlassian's personal data reporting API, as Atlassian's user
 * privacy guidelines require. Names are not kept: a decision's snapshot drops
 * the people from the context it records, and the per-person context cache is
 * purged once it expires, so neither needs reporting.
 */

/** Written over an account id when Atlassian says the account is closed. */
export const ERASED_ACCOUNT = 'erased';

/** Atlassian's default reporting cycle. An account is reported at most once per cycle. */
export const REPORT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export function isReportableAccount(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID.test(id) && id !== 'unknown' && id !== ERASED_ACCOUNT;
}

export interface TrackedAccount {
  accountId: string;
  /** When Covenant first stored this account's data: the `updatedAt` it reports. */
  storedAtMs: number;
  reportedAtMs: number | null;
}

/** Accounts to report in this run: never reported first, then the longest waiting, at most `limit`. */
export function accountsDue(tracked: readonly TrackedAccount[], nowMs: number, cycleMs: number = REPORT_CYCLE_MS, limit = 900): TrackedAccount[] {
  return tracked
    .filter((a) => isReportableAccount(a.accountId) && (a.reportedAtMs === null || nowMs - a.reportedAtMs >= cycleMs))
    .sort((a, b) => (a.reportedAtMs ?? Number.NEGATIVE_INFINITY) - (b.reportedAtMs ?? Number.NEGATIVE_INFINITY))
    .slice(0, limit);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function without(items: unknown, key: string): { value: unknown; changed: boolean } {
  if (!Array.isArray(items)) return { value: items, changed: false };
  let changed = false;
  const value = items.map((item) => {
    if (!isObject(item) || !(key in item)) return item;
    changed = true;
    const { [key]: _dropped, ...rest } = item;
    return rest;
  });
  return { value, changed };
}

/**
 * The context a decision was made on, without the people in it: assignees,
 * goal owners and suggested owners become a count. Work items, goals and
 * teams stay, so the record still says what the decision was based on.
 */
export function depersonaliseSnapshot(snapshot: unknown): { value: unknown; changed: boolean } {
  if (!isObject(snapshot) || !isObject(snapshot.context)) return { value: snapshot, changed: false };
  const context = { ...snapshot.context };
  let changed = false;

  const related = without(context.related, 'assignee');
  const goals = without(context.goals, 'owner');
  if (related.changed) context.related = related.value;
  if (goals.changed) context.goals = goals.value;
  changed = related.changed || goals.changed;

  if ('owners' in context) {
    context.suggestedOwners = Array.isArray(context.owners) ? context.owners.length : 0;
    delete context.owners;
    changed = true;
  }
  return changed ? { value: { ...snapshot, context }, changed } : { value: snapshot, changed: false };
}
