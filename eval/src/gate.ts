/**
 * The quality gate. `eval/baseline.json` holds the last recorded scores; a
 * build whose scores are lower fails. Raising the baseline is a deliberate
 * edit to that file, reviewed like any other change.
 */

export interface Baseline {
  /** Trap contracts that passed every check, out of the total. */
  traps: { passed: number; total: number };
  /** CUAD exact-match counts from eval/report.md, out of pairs with a CUAD value. */
  eval: { noticeExact: number; noticeTotal: number; allExact: number; allTotal: number; wrong: number };
}

export interface GateResult {
  ok: boolean;
  failures: string[];
}

export function gateTraps(baseline: Baseline['traps'], now: { passed: number; total: number }): GateResult {
  const failures: string[] = [];
  if (now.total < baseline.total) failures.push(`the suite shrank: ${now.total} traps, baseline ${baseline.total}`);
  if (now.passed < baseline.passed) failures.push(`traps passed: ${now.passed}, baseline ${baseline.passed}`);
  return { ok: failures.length === 0, failures };
}

export function gateEval(baseline: Baseline['eval'], now: Baseline['eval']): GateResult {
  const failures: string[] = [];
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
  if (rate(now.noticeExact, now.noticeTotal) < rate(baseline.noticeExact, baseline.noticeTotal)) {
    failures.push(`notice exact match: ${now.noticeExact}/${now.noticeTotal}, baseline ${baseline.noticeExact}/${baseline.noticeTotal}`);
  }
  if (rate(now.allExact, now.allTotal) < rate(baseline.allExact, baseline.allTotal)) {
    failures.push(`exact match on all four labels: ${now.allExact}/${now.allTotal}, baseline ${baseline.allExact}/${baseline.allTotal}`);
  }
  // A wrong answer is worse than a withheld one, so wrong answers may never go up.
  if (now.wrong > baseline.wrong) failures.push(`wrong answers: ${now.wrong}, baseline ${baseline.wrong}`);
  return { ok: failures.length === 0, failures };
}
