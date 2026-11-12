import { type IsoDate, compareDates } from './dates/civil';

/**
 * Owner suggestions for a renewal decision: people ranked by their history on
 * the work around a contract, each with the evidence that put them there.
 * With no evidence the answer is an empty list, never a guess.
 */

export type EvidenceKind = 'assignee' | 'commenter' | 'goal_owner' | 'reporter' | 'team_member';

export interface Evidence {
  accountId: string;
  name: string | null;
  kind: EvidenceKind;
  /** The work item or goal key, or null for team membership. */
  itemKey: string | null;
  /** A short label for the item, for example "MOBL-64 Quarterly service review", or the team's name. */
  itemLabel: string;
  at: IsoDate | null;
}

export const EVIDENCE_WEIGHTS: Record<EvidenceKind, number> = {
  assignee: 3,
  commenter: 2,
  goal_owner: 2,
  reporter: 1,
  team_member: 1,
};

export interface OwnerSuggestion {
  accountId: string;
  name: string | null;
  score: number;
  latest: IsoDate | null;
  /** Up to four lines, strongest evidence first. */
  evidence: string[];
}

const MAX_EVIDENCE_LINES = 4;

function line(e: Evidence): string {
  const when = e.at ? ` (${e.at})` : '';
  switch (e.kind) {
    case 'assignee':
      return `Assignee of ${e.itemLabel}${when}`;
    case 'commenter':
      return `Commented on ${e.itemLabel}${when}`;
    case 'goal_owner':
      return `Owns the goal ${e.itemLabel}`;
    case 'reporter':
      return `Reported ${e.itemLabel}${when}`;
    case 'team_member':
      return `Member of ${e.itemLabel}, a team linked to this space`;
  }
}

const later = (a: IsoDate | null, b: IsoDate | null): IsoDate | null => (a === null ? b : b === null ? a : compareDates(a, b) >= 0 ? a : b);

/** Newest first; items without a date last. */
const newestFirst = (a: IsoDate | null, b: IsoDate | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : compareDates(b, a));

export function rankOwners(evidence: readonly Evidence[], options: { exclude?: readonly string[]; limit?: number } = {}): OwnerSuggestion[] {
  const excluded = new Set(options.exclude ?? []);
  const people = new Map<string, { name: string | null; items: Map<string, Evidence>; latest: IsoDate | null }>();

  for (const e of evidence) {
    if (excluded.has(e.accountId)) continue;
    const person = people.get(e.accountId) ?? { name: e.name, items: new Map(), latest: null };
    person.name ??= e.name;
    const key = `${e.kind}|${e.itemKey ?? e.itemLabel}`;
    const seen = person.items.get(key);
    person.items.set(key, seen === undefined ? e : { ...seen, at: later(seen.at, e.at) });
    person.latest = later(person.latest, e.at);
    people.set(e.accountId, person);
  }

  const ranked = [...people.entries()].map(([accountId, p]): OwnerSuggestion => {
    const items = [...p.items.values()].sort((a, b) => EVIDENCE_WEIGHTS[b.kind] - EVIDENCE_WEIGHTS[a.kind] || newestFirst(a.at, b.at));
    return {
      accountId,
      name: p.name,
      score: items.reduce((sum, e) => sum + EVIDENCE_WEIGHTS[e.kind], 0),
      latest: p.latest,
      evidence: items.slice(0, MAX_EVIDENCE_LINES).map(line),
    };
  });

  ranked.sort((a, b) => b.score - a.score || newestFirst(a.latest, b.latest) || (a.name ?? a.accountId).localeCompare(b.name ?? b.accountId));
  return ranked.slice(0, options.limit ?? 5);
}
