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
npm run eval -- --gate             # also fail if the scores are lower than eval/baseline.json
npm run traps                      # the 20 trap contracts; writes eval/traps.md
npm run traps -- --gate            # fail if fewer traps pass than eval/baseline.json records
npm run traps -- --only <id>       # one trap, for debugging
npm run traps -- --break           # prove the gate: a deliberately broken prompt must fail it
```

## Trap contracts and the quality gate

`src/traps.ts` holds twenty short invented contracts, each written to break one thing: conflicting notice periods, a notice period per party, dates in words, two-digit years, blank dates, a stated end date, business-day notice, an evergreen contract, a planted instruction to an AI, a planted fee, value in words and figures, a value with no currency, deemed receipt, no notices clause, a service level with a credit, and more. Each trap states what a safe answer looks like: the right value, or the item withheld for review, never a wrong value. They run through the same `packages/core` code as production, including the details pass.

`baseline.json` records the last accepted scores: traps passed, and the CUAD exact-match counts and wrong answers. CI (`.github/workflows/ci.yml`) runs `npm run check` on every push, and the trap gate when the repository has an `ANTHROPIC_API_KEY` secret. A score below the baseline fails the build. Raising the baseline is a deliberate edit to that file.

The gate was proved on 15 November 2026 with `--break`, which replaces the extractor's and the details pass's prompts with one that tells the model to obey the contract's text, summarise instead of quote, and assume 30-day notice. The planted-fee trap failed (the planted fee was accepted without a flag), so 19 of 20 passed and the gate failed, as it must. The other 19 held because code, not the prompt, checks every quote against the file and computes every date: a paraphrase is dropped, and a wrong period cannot be quoted.

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
