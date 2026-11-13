import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * "Never log contract text. Log ids, counts and timings." Every value a log
 * line interpolates in src/ is checked against names that could carry text:
 * quotes, summaries, titles, file names, rationales, raw errors. Errors go
 * through loggableError(), which keeps the name and status only. Phase 0
 * spikes are excluded: they are throwaway code and already log shapes only.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'spikes' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const CALL = /console\.(?:log|error|warn|info|debug)\(([\s\S]*?)\);/g;
const INTERPOLATION = /\$\{([^}]*)\}/g;
// Names that can hold contract or user text.
const TEXTY = /\b(quote|quotes|text|summary|title|fileName|filename|rationale|description|message|body|payload|terms|rule|facts|clause|heading|reason\.detail|evidence|name)\b/i;
// Allowed wrappers and plain counters. `name` is fine as the resolver or tool name parameter.
const ALLOWED = [/^loggableError\(\w+\)$/, /\.length$/, /^name$/];

interface Finding {
  file: string;
  expression: string;
}

function audit(sources: Array<{ file: string; source: string }> = files(SRC).map((f) => ({ file: f, source: readFileSync(f, 'utf8') }))): {
  calls: number;
  findings: Finding[];
} {
  const findings: Finding[] = [];
  let calls = 0;
  for (const { file, source } of sources) {
    for (const call of source.matchAll(CALL)) {
      calls += 1;
      const args = call[1] ?? '';
      for (const m of args.matchAll(INTERPOLATION)) {
        const expression = (m[1] ?? '').trim();
        if (ALLOWED.some((ok) => ok.test(expression))) continue;
        // What is printed is the property read, not the object it hangs off: summary.contracts is a count,
        // o.rule.summary is text. So the root only counts when it is printed on its own.
        const names = expression.match(/[A-Za-z_$][\w$]*/g) ?? [];
        const printed = names.length === 1 ? names : names.slice(1);
        if (printed.some((n) => TEXTY.test(n))) findings.push({ file: relative(SRC, file), expression });
      }
      // A bare variable passed to console (not in a template) could be anything.
      if (!/^\s*[`'"]/.test(args)) findings.push({ file: relative(SRC, file), expression: args.trim().slice(0, 60) });
    }
  }
  return { calls, findings };
}

describe('log lines', () => {
  it('the audit catches text and lets counts through', () => {
    const sample = (source: string) => audit([{ file: join(SRC, 'sample.ts'), source }]).findings.map((f) => f.expression);
    expect(sample('console.log(`obligation ${o.id} ${o.rule.summary}`);')).toEqual(['o.rule.summary']);
    expect(sample('console.log(`file=${contract.fileName}`);')).toEqual(['contract.fileName']);
    expect(sample('console.error(`failed: ${error.message}`);')).toEqual(['error.message']);
    expect(sample('console.log(`q=${quote}`);')).toEqual(['quote']);
    expect(sample('console.error(error);')).toEqual(['error']);
    expect(sample('console.log(`daily contracts=${summary.contracts} rows=${rows.length} error=${loggableError(e)}`);')).toEqual([]);
  });

  it('never interpolate a value that could hold contract text', () => {
    const { calls, findings } = audit();
    expect(calls).toBeGreaterThan(30);
    expect(findings).toEqual([]);
  });
});
