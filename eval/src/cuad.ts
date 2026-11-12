import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads CUAD v1 (The Atticus Project, CC BY 4.0) from eval/data/cuad:
 * CUAD_v1.json for each contract's text and labelled spans, master_clauses.csv
 * for the annotators' normalised answers ("90 days", "4/1/18", "perpetual").
 *
 * CUAD files never go in git or in the app. eval/data/ is git-ignored.
 */

export const LABELS = ['Effective Date', 'Expiration Date', 'Renewal Term', 'Notice Period To Terminate Renewal'] as const;
export type Label = (typeof LABELS)[number];

export interface GoldSpan {
  /** Character offsets into `text`. */
  start: number;
  end: number;
}

export interface CuadContract {
  /** The CUAD document title. Used as the id in reports. */
  id: string;
  text: string;
  spans: Record<Label, GoldSpan[]>;
  /** The normalised answer cell from master_clauses.csv; '' when empty. */
  answers: Record<Label, string>;
}

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV filenames and JSON titles differ in punctuation and extension; letters and digits agree. */
export const joinKey = (name: string): string => name.replace(/\.pdf'?$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Notice Period To Terminate Renewal- Answer" and "Effective Date-Answer" both name an answer column. */
const answerColumn = (header: readonly string[], label: Label): number =>
  header.findIndex((h) => h.replace(/\s*-\s*/g, '-').trim() === `${label}-Answer`);

interface CuadJson {
  data: Array<{
    title: string;
    paragraphs: Array<{ context: string; qas: Array<{ id: string; answers: Array<{ text: string; answer_start: number }> }> }>;
  }>;
}

export interface LoadedCuad {
  contracts: CuadContract[];
  /** CSV rows with no matching JSON document. */
  unmatched: number;
}

export function buildCuad(json: CuadJson, csvText: string): LoadedCuad {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];
  const columns = LABELS.map((label) => [label, answerColumn(header, label)] as const);
  for (const [label, index] of columns) {
    if (index < 0) throw new Error(`master_clauses.csv has no answer column for ${label}`);
  }
  const answersByKey = new Map<string, Record<Label, string>>();
  for (const row of rows.slice(1)) {
    if (row.length < 2) continue;
    const answers = Object.fromEntries(columns.map(([label, index]) => [label, (row[index] ?? '').trim()])) as Record<Label, string>;
    answersByKey.set(joinKey(row[0] ?? ''), answers);
  }

  const contracts: CuadContract[] = [];
  for (const doc of json.data) {
    const paragraph = doc.paragraphs[0];
    const answers = answersByKey.get(joinKey(doc.title));
    if (!paragraph || !answers) continue;
    const spans = Object.fromEntries(
      LABELS.map((label) => {
        const qa = paragraph.qas.find((q) => q.id.endsWith(`__${label}`));
        return [label, (qa?.answers ?? []).map((a) => ({ start: a.answer_start, end: a.answer_start + a.text.length }))];
      }),
    ) as Record<Label, GoldSpan[]>;
    contracts.push({ id: doc.title, text: paragraph.context, spans, answers });
  }
  return { contracts, unmatched: answersByKey.size - contracts.length };
}

export function loadCuad(dir: string): LoadedCuad {
  const json = JSON.parse(readFileSync(join(dir, 'CUAD_v1.json'), 'utf8')) as CuadJson;
  return buildCuad(json, readFileSync(join(dir, 'master_clauses.csv'), 'utf8'));
}

/** Small, fast, seeded PRNG so the sample is the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface SampleOptions {
  seed: number;
  /** How many contracts that have a notice-period answer, and how many others. */
  withNotice: number;
  others: number;
  /** Product scope is contracts up to 40 pages; this is the character budget for that. */
  maxChars: number;
}

export const EVAL_SAMPLE: SampleOptions = { seed: 20261117, withNotice: 15, others: 15, maxChars: 120_000 };

/** Contracts for prompt work, disjoint from the scored sample, so tuning never sees the test set. */
export const DEV_SAMPLE: SampleOptions = { seed: 20261117, withNotice: 5, others: 5, maxChars: 120_000 };

const hasNoticeAnswer = (c: CuadContract): boolean => /\d/.test(c.answers['Notice Period To Terminate Renewal']);

/**
 * A deterministic, stratified sample. Notice periods are the headline metric
 * but only a fifth of CUAD has one, so half the sample is drawn from those.
 * `split: 'dev'` draws the next contracts in the same shuffled order, so dev
 * and eval never overlap.
 */
export function selectSample(contracts: readonly CuadContract[], options: SampleOptions, split: 'eval' | 'dev' = 'eval'): CuadContract[] {
  const random = mulberry32(options.seed);
  const eligible = [...contracts].filter((c) => c.text.length <= options.maxChars).sort((a, b) => a.id.localeCompare(b.id));
  const notice = shuffled(eligible.filter(hasNoticeAnswer), random);
  const rest = shuffled(eligible.filter((c) => !hasNoticeAnswer(c)), random);
  const [n, o] = [EVAL_SAMPLE.withNotice, EVAL_SAMPLE.others];
  const picked =
    split === 'eval'
      ? [...notice.slice(0, options.withNotice), ...rest.slice(0, options.others)]
      : [...notice.slice(n, n + options.withNotice), ...rest.slice(o, o + options.others)];
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}
