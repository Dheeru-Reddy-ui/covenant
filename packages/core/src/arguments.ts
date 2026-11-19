import { z } from 'zod';

/**
 * Tool arguments as the model meant them, before the strict check.
 *
 * Over Forge LLMs, long real contracts showed two encoding habits that the
 * Anthropic API eval never produced: a field whose value is null left out
 * altogether, and a nested object or list sent as JSON text. Neither carries
 * a value the model did not give, so both are undone here, guided only by the
 * schema: a missing field the schema allows to be null becomes null, and text
 * where the schema wants an object or a list is parsed if it is exactly that.
 *
 * Nothing else changes. A missing required field stays missing, an unexpected
 * field stays, a text field is never parsed, and every refinement still runs,
 * so an answer that leaves out a value it needed (a recurrence for a periodic
 * duty, a date or an event for the effective date) is still refused.
 */

export interface Tidied {
  value: unknown;
  /** Paths where a missing field was read as null. */
  filledNulls: string[];
  /** Paths where JSON text was read as the object, list or null it spelled. */
  unwrapped: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The schema under any nullable or optional wrapper, and whether null is allowed. */
function peel(schema: z.ZodType): { inner: z.ZodType; nullable: boolean } {
  let inner = schema;
  let nullable = false;
  for (;;) {
    if (inner instanceof z.ZodNullable) {
      nullable = true;
      inner = inner.unwrap() as z.ZodType;
    } else if (inner instanceof z.ZodOptional) {
      inner = inner.unwrap() as z.ZodType;
    } else return { inner, nullable };
  }
}

const join = (path: string, key: string | number): string => (path === '' ? String(key) : `${path}.${key}`);

export function tidyArguments(schema: z.ZodType, value: unknown): Tidied {
  const filledNulls: string[] = [];
  const unwrapped: string[] = [];

  const walk = (s: z.ZodType, v: unknown, path: string): unknown => {
    const { inner, nullable } = peel(s);
    const wantsObject = inner instanceof z.ZodObject;
    const wantsArray = inner instanceof z.ZodArray;
    if (!wantsObject && !wantsArray) return v;

    let current = v;
    if (typeof current === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(current);
      } catch {
        return current;
      }
      const fits = (parsed === null && nullable) || (wantsObject && isPlainObject(parsed)) || (wantsArray && Array.isArray(parsed));
      if (!fits) return current;
      unwrapped.push(path);
      current = parsed;
    }

    if (wantsArray && Array.isArray(current)) {
      const element = (inner as z.ZodArray<z.ZodType>).element;
      return current.map((item, i) => walk(element, item, join(path, i)));
    }
    if (wantsObject && isPlainObject(current)) {
      const shape = (inner as z.ZodObject).shape as Record<string, z.ZodType>;
      const out: Record<string, unknown> = { ...current };
      for (const [key, field] of Object.entries(shape)) {
        if (!(key in current)) {
          if (field instanceof z.ZodNullable) {
            out[key] = null;
            filledNulls.push(join(path, key));
          }
          continue;
        }
        out[key] = walk(field, current[key], join(path, key));
      }
      return out;
    }
    return current;
  };

  return { value: walk(schema, value, ''), filledNulls, unwrapped };
}

/** The JSON type of a value, as a word: "string", "object", "undefined". */
function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let v = root;
  for (const key of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[key];
  }
  return v;
}

/** Digests folded for a log line: item numbers become N, repeats are counted, most common first. */
export function summariseProblems(digests: readonly string[]): string {
  if (digests.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const d of digests) {
    const key = d.replace(/\.\d+(?=[.:]|$)/g, '.N');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} x${n}`)
    .join('; ');
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Why a value failed its schema, safe to log: the path, the kind of problem,
 * the type expected and the type received. Never a value, so never contract
 * text. An unexpected key is named only when it looks like a field name.
 */
export function problemDigest(prefix: string, error: z.ZodError, input: unknown): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter((p) => p !== '').join('.');
    let what: string = issue.code;
    if (issue.code === 'invalid_type') what += ` expected ${issue.expected} got ${typeName(valueAt(input, issue.path))}`;
    if (issue.code === 'unrecognized_keys') what += ` ${issue.keys.map((k) => (FIELD_NAME.test(k) ? k : '?')).join(',')}`;
    return path === '' ? what : `${path}: ${what}`;
  });
}
