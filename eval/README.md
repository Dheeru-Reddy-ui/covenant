# Covenant eval

Scores `packages/core` (the extractor, verifier, critic and date engine) against
contracts from CUAD, using the same model id production uses on Forge LLMs:
`claude-haiku-4-5-20251001` (`PRODUCTION_MODEL` in `packages/core/src/llm.ts`).
The latest results are in [report.md](report.md).

## What it measures

Four CUAD labels, per contract: Effective Date, Expiration Date, Renewal Term
and Notice Period To Terminate Renewal.

- **Clause recall:** Covenant quoted the clause CUAD highlights.
- **Exact match:** Covenant's final value equals CUAD's answer. Abstaining counts as a miss.
- **Grounding rate:** the share of quotes the model returned that appear verbatim in the contract.
- **Abstain rate:** Covenant found the clause but held the value back for a person.

The definitions are spelled out in the report's Method section and in `src/score.ts`.

## Setup

1. Download CUAD v1's two files into `eval/data/cuad/`. Git ignores `eval/data/`, and CUAD never goes into the app.

   ```bash
   mkdir -p eval/data/cuad
   curl -L -o eval/data/cuad/CUAD_v1.json https://huggingface.co/datasets/theatticusproject/cuad/resolve/main/CUAD_v1/CUAD_v1.json
   curl -L -o eval/data/cuad/master_clauses.csv https://huggingface.co/datasets/theatticusproject/cuad/resolve/main/CUAD_v1/master_clauses.csv
   ```

   `CUAD_v1.json` is 40.1 MB, with SHA-256 `ed0b77d85bdf4014d7495800e8e4a70565b48ee6f8a2e5dca9cf8655dbf10eae`. `master_clauses.csv` is 4.0 MB.

2. Set `ANTHROPIC_API_KEY` in your environment. The harness reads it through the SDK and never prints it.

## Commands

```bash
npm run eval                       # the 30-contract scored split; writes eval/report.md
npm run eval -- --dev              # 10 different contracts for prompt work; writes eval/data/dev-report.md
npm run eval -- --limit 3          # a quick partial run; writes eval/data/eval-report.md
npm run eval -- --rescore <file>   # rebuild a report from a saved run in eval/data/runs, no model calls
```

A full run costs about $1 to $2 at Haiku 4.5 prices. The console shows contract ids, counts and timings only.

## Why the SDK is pinned to 0.137.0

`@anthropic-ai/sdk` 1.0.0 and later send API version `2026-10-21`, which rejects `temperature` on every model.
Production calls Haiku 4.5 on Forge LLMs at temperature 0. Release 0.137.0 is the last one that sends `2023-06-01`, so the eval can call the model the same way.

## Sample

The sample is seeded and stratified. It draws only from contracts of at most 120,000 characters, roughly the product's 40-page scope:

- 15 contracts with a CUAD notice-period answer, since notice periods are the headline metric
- 15 contracts without one

The dev split holds the next 10 contracts in the same shuffled order, so prompt work never sees the scored contracts.

## Credit

CUAD v1, the Contract Understanding Atticus Dataset, by The Atticus Project, licensed CC BY 4.0: https://doi.org/10.5281/zenodo.4595826.
Hendrycks, Burns, Chen and Ball, "CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review", NeurIPS 2021.
