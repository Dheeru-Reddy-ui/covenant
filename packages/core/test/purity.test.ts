import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// packages/core must run unchanged under tests, in the eval harness and inside Forge.
// That only holds while it imports nothing from Forge, Node or the browser.
const SRC = fileURLToPath(new URL('../src', import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });

const ALLOWED_PACKAGES = new Set(['zod']);
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

describe('packages/core stays pure', () => {
  const files = walk(SRC).map((file) => [file.slice(SRC.length + 1), file] as const);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports only relative files and allowed packages', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? '';
      const allowed = specifier.startsWith('./') || specifier.startsWith('../') || ALLOWED_PACKAGES.has(specifier);
      expect(allowed, `${specifier} is not allowed in packages/core`).toBe(true);
    }
  });

  it.each(files)('%s never reads the clock or writes to the console', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/\bDate\.now\s*\(|\bnew Date\s*\(/);
    expect(text).not.toMatch(/\bconsole\.\w+\s*\(/);
  });
});
