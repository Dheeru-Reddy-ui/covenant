import { describe, expect, it } from 'vitest';
import { ERASED_ACCOUNT, REPORT_CYCLE_MS, accountsDue, depersonaliseSnapshot, isReportableAccount } from '../src/privacy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe('isReportableAccount', () => {
  it('accepts Atlassian account ids', () => {
    expect(isReportableAccount('5b10ac8d82e05b22cc7d4ef5')).toBe(true);
    expect(isReportableAccount('712020:9c1f3c39-1b21-4d0e-9d8a-1e3c5d7f9a0b')).toBe(true);
  });

  it('refuses placeholders, blanks and anything that is not an id', () => {
    for (const id of ['', 'unknown', ERASED_ACCOUNT, null, undefined, 42, 'has space', 'x'.repeat(129)]) {
      expect(isReportableAccount(id)).toBe(false);
    }
  });
});

describe('accountsDue', () => {
  const tracked = [
    { accountId: 'reported-yesterday', storedAtMs: NOW - 30 * DAY, reportedAtMs: NOW - DAY },
    { accountId: 'never-reported', storedAtMs: NOW - 2 * DAY, reportedAtMs: null },
    { accountId: 'reported-8-days-ago', storedAtMs: NOW - 60 * DAY, reportedAtMs: NOW - 8 * DAY },
    { accountId: 'reported-10-days-ago', storedAtMs: NOW - 60 * DAY, reportedAtMs: NOW - 10 * DAY },
  ];

  it('reports each account at most once a cycle, never-reported first, then the longest waiting', () => {
    expect(accountsDue(tracked, NOW).map((a) => a.accountId)).toEqual(['never-reported', 'reported-10-days-ago', 'reported-8-days-ago']);
  });

  it('counts a report exactly one cycle old as due', () => {
    expect(accountsDue([{ accountId: 'a', storedAtMs: 0, reportedAtMs: NOW - REPORT_CYCLE_MS }], NOW)).toHaveLength(1);
    expect(accountsDue([{ accountId: 'a', storedAtMs: 0, reportedAtMs: NOW - REPORT_CYCLE_MS + 1 }], NOW)).toHaveLength(0);
  });

  it('caps one run, so a large site spreads its reports over days', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ accountId: `acc-${i}`, storedAtMs: 0, reportedAtMs: null }));
    expect(accountsDue(many, NOW, REPORT_CYCLE_MS, 20)).toHaveLength(20);
  });

  it('skips anything that is not a reportable id', () => {
    expect(accountsDue([{ accountId: ERASED_ACCOUNT, storedAtMs: 0, reportedAtMs: null }], NOW)).toEqual([]);
  });
});

describe('depersonaliseSnapshot', () => {
  const snapshot = {
    takenAt: '2026-11-12',
    window: { status: 'due', deadline: '2026-12-02' },
    context: {
      fetchedAtMs: 1,
      cached: true,
      related: [{ key: 'MOBL-64', summary: 'Quarterly review', type: 'Task', status: 'To Do', assignee: 'Alex Doe', incident: false, viaCovenant: false }],
      goals: [{ name: 'Cut freight costs', key: 'G-1', url: null, due: null, owner: 'Sam Roe' }],
      teams: [{ name: 'Logistics', url: null, members: 4 }],
      owners: [{ accountId: '5b10ac8d82e05b22cc7d4ef5', name: 'Alex Doe', score: 9, evidence: ['Assignee of MOBL-64'] }],
      problems: [],
    },
  };

  it('keeps the work, goals and teams a decision saw, without the people', () => {
    const { value, changed } = depersonaliseSnapshot(snapshot);
    expect(changed).toBe(true);
    expect(value).toEqual({
      takenAt: '2026-11-12',
      window: { status: 'due', deadline: '2026-12-02' },
      context: {
        fetchedAtMs: 1,
        cached: true,
        related: [{ key: 'MOBL-64', summary: 'Quarterly review', type: 'Task', status: 'To Do', incident: false, viaCovenant: false }],
        goals: [{ name: 'Cut freight costs', key: 'G-1', url: null, due: null }],
        teams: [{ name: 'Logistics', url: null, members: 4 }],
        suggestedOwners: 1,
        problems: [],
      },
    });
    expect(JSON.stringify(value)).not.toMatch(/Alex Doe|Sam Roe|5b10ac8d/);
  });

  it('leaves a snapshot without people alone', () => {
    const once = depersonaliseSnapshot(snapshot).value;
    expect(depersonaliseSnapshot(once)).toEqual({ value: once, changed: false });
    expect(depersonaliseSnapshot({ takenAt: '2026-11-12', context: null })).toEqual({ value: { takenAt: '2026-11-12', context: null }, changed: false });
    expect(depersonaliseSnapshot(null)).toEqual({ value: null, changed: false });
  });
});
