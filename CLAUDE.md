# Covenant: instructions for coding agents

Covenant is a Forge app for Atlassian's Codegeist 2026 hackathon, built by one developer at 10 to 15 hours a week.
Official deadline: Tue 22 Dec 2026, 12:00 PT. Target submission: 21 Dec 2026. Judging runs 5 Jan to 3 Feb 2027, so the app must keep working until then.

## What it does

A user attaches a contract (text PDF or DOCX) to a Jira work item and clicks Extract. Covenant pulls out the contract's obligations and shows each one with its verbatim clause and page. After a person reviews them, it creates child work items with due dates. Before a renewal notice window closes, it opens a decision item with a brief. A Rovo agent and an MCP server expose the same four actions.

## Trust rules (these hold everywhere)

- The model only reads text and returns structured rules: kind, responsible party, anchor event, offset (number, unit, direction), recurrence, quote, page hint. It never returns a calendar date.
- Deterministic code in `packages/core/src/dates` resolves rules into dates. It has unit and property-based tests.
- Every obligation's quote must appear verbatim in the source text after whitespace normalisation (`packages/core/src/verify.ts`). No match, no obligation.
- The page shown to users is derived by code from where the quote was found. The model's page is only a hint for choosing between repeats.
- Low-confidence or conflicting clauses get a second pass. If the passes disagree, the clause is marked "needs review". Never guess.
- Nothing is written to Jira until a person approves it.
- Never log contract text. Log ids, counts and timings.

## Layout

- `packages/core`: pure TypeScript, no Forge, Node or browser imports, never reads the clock or logs (enforced by `test/purity.test.ts`). Schema, verifier, date engine; later the extractor and critic.
- `src/parse`: attachment bytes to page text (PDF via `unpdf/pdfjs`, DOCX via mammoth). No Forge imports.
- `src/forge`: resolvers, queue consumer, scheduled trigger, the four actions, SQL repositories, Teamwork Graph client. `src/forge/spikes` is Phase 0 throwaway code.
- `src/frontend`: UI Kit screens.
- `eval/`: scores `packages/core` against CUAD. CUAD files never go in git or in the app.
- `samples/fictional`: an invented contract for tests and demos.
- `docs/spikes.md`: Phase 0 results.

## Platform facts (checked on developer.atlassian.com, 11 Nov 2026)

- UI functions time out at 25 s; actions and rovo:agentConnector at 55 s; queue consumers and scheduled triggers default to 55 s and allow `timeoutSeconds` up to 900. Extraction runs in a queue consumer; the Rovo/MCP Extract tool must enqueue, not run inline.
- One `llm` module and one `rovo:mcp` module per app. Both, and `sql`, are declared from the first deploy because adding `llm` or `sql` later forces a major version.
- Forge LLMs: `@forge/llm` `chat()`; no JSON mode, so structure is forced with one tool plus `tool_choice`. Tool arguments arrive as a JSON string even though the SDK types say object (spike S2). The only Haiku is `claude-haiku-4-5-20251001`, past its earliest retirement date; keep the model id in config with `claude-sonnet-4-6` as fallback, and record the model on each run. The eval must use the same model id as production. LLM tokens have no free allowance and are billed to the developer.
- Forge SQL: no foreign keys, one statement per query, `?` parameters, SELECT 5 s, request 1 MiB, response 4 MiB.
- `@forge/events` 2.x+: events wrapped in `body`; 50 events or 200 KB per push, so pass ids, not text.
- Teamwork Graph (Preview): `api.asUser().requestTeamworkGraph(query, variables, operationName)` only. Operation names are `covenant_<name>` (name 4+ chars). HTTP 200 can carry errors; missing scopes silently drop rows; page until `hasNextPage` is false; never call it from a scheduled or queued function.
- rovo:mcp (Preview): tools are action keys; external access is off until a site or org admin enables it; endpoint `https://mcp.atlassian.com/forge/<appId>`.
- unpdf's main entry cannot be bundled by Forge (it calls `import.meta.resolve('pdfjs-dist/...')`); import `getDocument` from `unpdf/pdfjs` instead.

## Environment

- App id `ari:cloud:ecosystem::app/0eb73671-31a0-4410-ae90-4d8ba0607caa`, Developer Space `dheeru-dev`, runtime `nodejs22.x`.
- Forge CLI 14.2.0 (15.x needs Node 22.23.4+; this machine has 22.15.0). In Git Bash, add `C:\Users\dheer\AppData\Roaming\npm` to PATH to find `forge`.
- Forge commands that prompt (register, create, terms) must run in a real terminal. Never run `forge create` in this folder: it writes a template app over these files.

## How to work

- One phase at a time from the build plan. Before coding, restate the phase's "done when" and list the files you will touch.
- Write tests first for anything in `packages/core`.
- Keep each change small enough to deploy and try, and give the exact commands.
- Before using any Forge module, package or API, check its current page on developer.atlassian.com and report what you found. If unsure something exists, write a small spike instead of guessing.
- If something is impossible on Forge, stop and say so, with the closest alternative.

## Commands

```
npm run check                      # type-check everything and run core tests
npm test                           # core tests only
npm run samples                    # rebuild the fictional sample PDF and DOCX and verify their clauses
npm run spike:local -- <file>      # local fingerprint of a PDF or DOCX, to compare with spike S1
forge deploy -e development
forge install --upgrade --site <site>.atlassian.net --product jira
forge logs -e development
```

## Do not build

Amendments, OCR, Confluence or Jira Service Management screens, Marketplace licensing, or anything that calls an external service from the deployed app.
