import { describe, expect, it } from 'vitest';
import { type Evidence, rankOwners } from '../src/owners';

const ev = (accountId: string, kind: Evidence['kind'], itemKey: string | null, at: string | null = null, name = accountId.toUpperCase()): Evidence => ({
  accountId,
  name,
  kind,
  itemKey,
  itemLabel: itemKey ? `${itemKey} Some work` : 'Team Ops',
  at,
});

describe('rankOwners', () => {
  it('ranks people by weighted history on related work, with the evidence beside each name', () => {
    const owners = rankOwners([
      ev('ana', 'assignee', 'A-1', '2026-10-01'),
      ev('ana', 'commenter', 'A-2', '2026-11-01'),
      ev('ben', 'reporter', 'A-1', '2026-09-01'),
      ev('ben', 'reporter', 'A-3', '2026-09-02'),
      ev('cy', 'team_member', null),
    ]);
    expect(owners.map((o) => o.accountId)).toEqual(['ana', 'ben', 'cy']);
    expect(owners[0]).toMatchObject({ name: 'ANA', score: 5, latest: '2026-11-01' });
    expect(owners[0]?.evidence).toEqual(['Assignee of A-1 Some work (2026-10-01)', 'Commented on A-2 Some work (2026-11-01)']);
    expect(owners[2]?.evidence).toEqual(['Member of Team Ops, a team linked to this space']);
  });

  it('counts the same person, role and item once', () => {
    const [only] = rankOwners([ev('ana', 'commenter', 'A-1', '2026-10-01'), ev('ana', 'commenter', 'A-1', '2026-10-05'), ev('ana', 'commenter', 'A-1', null)]);
    expect(only).toMatchObject({ score: 2, latest: '2026-10-05' });
    expect(only?.evidence).toHaveLength(1);
  });

  it('breaks ties by the most recent activity, then by name', () => {
    const owners = rankOwners([ev('zed', 'assignee', 'A-1', '2026-11-01'), ev('amy', 'assignee', 'A-2', '2026-10-01'), ev('bob', 'assignee', 'A-3', '2026-10-01')]);
    expect(owners.map((o) => o.accountId)).toEqual(['zed', 'amy', 'bob']);
  });

  it('leaves out excluded accounts, such as the app itself, and caps the list', () => {
    const many = Array.from({ length: 8 }, (_, i) => ev(`p${i}`, 'assignee', `A-${i}`));
    expect(rankOwners([...many, ev('app', 'assignee', 'A-9')], { exclude: ['app'], limit: 5 }).map((o) => o.accountId)).toHaveLength(5);
    expect(rankOwners([ev('app', 'assignee', 'A-9')], { exclude: ['app'] })).toEqual([]);
  });

  it('keeps at most four evidence lines, strongest first', () => {
    const [one] = rankOwners([
      ev('ana', 'reporter', 'A-1'),
      ev('ana', 'goal_owner', 'G-1'),
      ev('ana', 'assignee', 'A-2'),
      ev('ana', 'commenter', 'A-3'),
      ev('ana', 'assignee', 'A-4'),
    ]);
    expect(one?.evidence).toHaveLength(4);
    expect(one?.evidence[0]).toMatch(/^Assignee of/);
    expect(one?.evidence.some((e) => e.startsWith('Reported'))).toBe(false);
    expect(one?.score).toBe(11);
  });

  it('suggests nobody rather than guess when there is no evidence', () => {
    expect(rankOwners([])).toEqual([]);
  });
});
