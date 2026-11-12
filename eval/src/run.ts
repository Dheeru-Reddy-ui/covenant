import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EXTRACTOR_VERSION, type ExtractionOutcome, PRODUCTION_MODEL, SCHEMA_VERSION, extractContract } from '../../packages/core/src';
import { API_VERSION, AnthropicLlmClient, SDK_VERSION, TEMPERATURE } from './anthropic-client';
import { type CuadContract, DEV_SAMPLE, EVAL_SAMPLE, loadCuad, selectSample } from './cuad';
import { type EvalRun, renderReport, scoreRun } from './report';
import { aggregate, rate } from './score';

/**
 * npm run eval                      score the 30-contract eval split, write eval/report.md
 * npm run eval -- --dev             the 10-contract dev split, for prompt work (report to eval/data/)
 * npm run eval -- --limit 3         a quick partial run (report to eval/data/)
 * npm run eval -- --rescore <file>  rebuild a report from a saved run, no model calls
 *
 * Prints contract ids, counts and timings only. Saved runs hold CUAD quotes and
 * stay in eval/data/, which git ignores.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(here, '..');
const CUAD_DIR = join(EVAL_DIR, 'data', 'cuad');
const RUNS_DIR = join(EVAL_DIR, 'data', 'runs');

const { values: args } = parseArgs({
  options: {
    dev: { type: 'boolean', default: false },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    rescore: { type: 'string' },
    'no-critic': { type: 'boolean', default: false },
  },
});

function reportPath(run: EvalRun, partial: boolean): string {
  return run.split === 'eval' && !partial ? join(EVAL_DIR, 'report.md') : join(EVAL_DIR, 'data', `${run.split}-report.md`);
}

function summarise(run: EvalRun, cuad: ReadonlyMap<string, CuadContract>, path: string): void {
  const scores = scoreRun(run, cuad);
  const notice = aggregate(scores.filter((s) => s.label === 'Notice Period To Terminate Renewal'));
  const all = aggregate(scores);
  const show = (n: number, d: number) => {
    const r = rate(n, d);
    return r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`;
  };
  console.log(`exact match, all four labels: ${show(all.exact, all.scorable)} (${all.exact}/${all.scorable})`);
  console.log(`exact match, notice periods:  ${show(notice.exact, notice.scorable)} (${notice.exact}/${notice.scorable}), target 85%`);
  console.log(`clause recall: ${show(all.clauseHits, all.clauseGold)}; abstained: ${show(all.abstained, all.scorable)}`);
  console.log(`report written to ${path}`);
}

async function pool<T, R>(items: readonly T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const { contracts, unmatched } = loadCuad(CUAD_DIR);
  const cuad = new Map(contracts.map((c) => [c.id, c]));

  if (args.rescore) {
    const run = JSON.parse(readFileSync(resolve(args.rescore), 'utf8')) as EvalRun;
    const path = reportPath(run, run.contracts.length < run.sample.withNotice + run.sample.others);
    writeFileSync(path, renderReport(run, cuad));
    summarise(run, cuad, path);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('No Anthropic credentials: set ANTHROPIC_API_KEY in your environment, then run this again.');
    process.exitCode = 1;
    return;
  }

  const split = args.dev ? 'dev' : 'eval';
  const sampleOptions = split === 'dev' ? DEV_SAMPLE : EVAL_SAMPLE;
  let sample = selectSample(contracts, sampleOptions, split);
  const partial = args.limit !== undefined;
  if (partial) sample = sample.slice(0, Number(args.limit));
  console.log(`CUAD: ${contracts.length} contracts loaded (${unmatched} unmatched); ${split} split: ${sample.length} contracts`);
  console.log(`model ${PRODUCTION_MODEL}, extractor v${EXTRACTOR_VERSION}, critic ${args['no-critic'] ? 'off' : 'on'}`);

  const client = AnthropicLlmClient.fromEnvironment(PRODUCTION_MODEL);
  const options = args['no-critic'] ? { critic: false as const } : {};
  const startedAt = new Date().toISOString();

  const extractOne = async (contract: CuadContract, index: number) => {
    const started = Date.now();
    const outcome: ExtractionOutcome = await extractContract({ pages: [{ page: 1, text: contract.text }] }, client, options);
    const ms = Date.now() - started;
    const status = outcome.status === 'ok' ? `ok, ${outcome.obligations.length} obligations` : `failed: ${outcome.reason}`;
    console.log(
      `[${index + 1}/${sample.length}] ${contract.id.slice(0, 50)}: ${status}, ${(ms / 1000).toFixed(1)} s, ${outcome.calls} calls, ${outcome.usage.inputTokens}/${outcome.usage.outputTokens} tokens`,
    );
    return { id: contract.id, chars: contract.text.length, ms, outcome };
  };

  // One contract first: a bad key or a missing model should stop the run before it spends anything else.
  const first = sample[0];
  if (!first) throw new Error('empty sample');
  const firstResult = await extractOne(first, 0);
  if (firstResult.outcome.status === 'failed' && firstResult.outcome.reason === 'llm_error') {
    console.error(`stopping: the first call failed (${firstResult.outcome.detail})`);
    process.exitCode = 1;
    return;
  }
  const rest = await pool(sample.slice(1), Number(args.concurrency), (c, i) => extractOne(c, i + 1));

  const run: EvalRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    split,
    sample: sampleOptions,
    model: client.modelId,
    reportedModels: [...client.reportedModels],
    sdkVersion: SDK_VERSION,
    apiVersion: API_VERSION,
    temperature: TEMPERATURE,
    extractorVersion: EXTRACTOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    criticEnabled: !args['no-critic'],
    contracts: [firstResult, ...rest],
  };

  mkdirSync(RUNS_DIR, { recursive: true });
  const runFile = join(RUNS_DIR, `${run.finishedAt.replace(/[:.]/g, '-')}-${split}.json`);
  writeFileSync(runFile, JSON.stringify(run, null, 2));
  console.log(`run saved to ${runFile}`);
  const path = reportPath(run, partial);
  writeFileSync(path, renderReport(run, cuad));
  summarise(run, cuad, path);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'eval failed');
  process.exitCode = 1;
});
