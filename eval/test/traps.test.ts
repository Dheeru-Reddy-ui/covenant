import { describe, expect, it } from 'vitest';
import { locateQuote } from '../../packages/core/src';
import { gateEval, gateTraps } from '../src/gate';
import { TRAPS } from '../src/traps';

describe('the trap suite', () => {
  it('has twenty traps with unique ids, each with a reason and at least one check', () => {
    expect(TRAPS).toHaveLength(20);
    expect(new Set(TRAPS.map((t) => t.id)).size).toBe(20);
    for (const t of TRAPS) {
      expect(t.trap.length, t.id).toBeGreaterThan(10);
      expect(t.checks.length, t.id).toBeGreaterThan(0);
      expect(t.text, t.id).toContain('fictional agreement written for testing');
    }
  });

  it('covers the cases the plan names', () => {
    const ids = TRAPS.map((t) => t.id);
    for (const id of ['conflicting-notice', 'per-party-notice', 'date-in-words', 'evergreen', 'business-day-notice', 'instruction-to-ai']) expect(ids).toContain(id);
  });

  it('fails every check when both passes fail, so no trap can pass by accident', () => {
    const failed = { status: 'failed', reason: 'llm_error', detail: 'x', calls: 0, usage: { inputTokens: 0, outputTokens: 0 } } as never;
    for (const t of TRAPS) {
      const failures = t.checks.map((c) => c({ extraction: failed, details: failed })).filter((f) => f !== null);
      expect(failures.length, t.id).toBeGreaterThan(0);
    }
  });

  it('keeps each trap contract readable as a source document', () => {
    for (const t of TRAPS) expect(locateQuote('This is a fictional agreement written for testing.', { pages: [{ page: 1, text: t.text }] }).status).toBe('verified');
  });
});

describe('the gate', () => {
  it('passes at or above the trap baseline and fails below it or when the suite shrinks', () => {
    expect(gateTraps({ passed: 18, total: 20 }, { passed: 18, total: 20 }).ok).toBe(true);
    expect(gateTraps({ passed: 18, total: 20 }, { passed: 20, total: 20 }).ok).toBe(true);
    expect(gateTraps({ passed: 18, total: 20 }, { passed: 17, total: 20 })).toEqual({ ok: false, failures: ['traps passed: 17, baseline 18'] });
    expect(gateTraps({ passed: 18, total: 20 }, { passed: 18, total: 19 }).ok).toBe(false);
  });

  it('fails the eval when exact match drops or wrong answers rise', () => {
    const base = { noticeExact: 14, noticeTotal: 15, allExact: 58, allTotal: 72, wrong: 0 };
    expect(gateEval(base, base).ok).toBe(true);
    expect(gateEval(base, { ...base, noticeExact: 13 }).ok).toBe(false);
    expect(gateEval(base, { ...base, allExact: 57 }).ok).toBe(false);
    expect(gateEval(base, { ...base, wrong: 1 }).failures).toEqual(['wrong answers: 1, baseline 0']);
    // A different sample size is compared by rate.
    expect(gateEval(base, { noticeExact: 5, noticeTotal: 5, allExact: 20, allTotal: 24, wrong: 0 }).ok).toBe(true);
  });
});
