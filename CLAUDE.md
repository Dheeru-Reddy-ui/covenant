# Covenant: instructions for coding agents

Covenant is a Forge app for Atlassian's Codegeist 2026 hackathon, built by one developer at 10 to 15 hours a week.
Official deadline: Tue 22 Dec 2026, 12:00 PT. Target submission: 21 Dec 2026. Judging runs 5 Jan to 3 Feb 2027, so the app must keep working until then.

## What it does

A user attaches a contract (text PDF or DOCX) to a Jira work item and clicks Extract. Covenant pulls out the contract's obligations and shows each one with its verbatim clause and page. After a person reviews them, it creates child work items with due dates. Before a renewal notice window closes, it opens a decision item with a brief. A Rovo agent and an MCP server expose the same four actions.

## Trust rules (these hold everywhere)

- The model only reads text and returns structured rules: kind, responsible party, anchor event, offset (number, unit, direction), recurrence, quote, page hint. It never returns a calendar date it worked out. A date the contract writes out (an effective date, a stated end date) may be copied as text from inside its verified quote; code parses it (`packages/core/src/dates/written.ts`) and sends blanks, two-digit years and ambiguous numeric dates to review.
- Deterministic code in `packages/core/src/dates` resolves rules into dates. It has unit and property-based tests.
- Every obligation's quote must appear verbatim in the source text after whitespace normalisation (`packages/core/src/verify.ts`). No match, no obligation.
- The page shown to users is derived by code from where the quote was found. The model's page is only a hint for choosing between repeats. So is the clause number ("clause 1.2 (Term and renewal)"): `packages/core/src/sections.ts` reads it from the text around the quote, stored in the `clause_section` table; older extractions are backfilled by the daily check (`src/forge/jobs/sections.ts`) by reparsing the file, with no model call.
- Low-confidence or conflicting clauses get a second pass. If the passes disagree, the clause is marked "needs review". Never guess.
- Nothing is written to Jira until a person approves it.
- Never log contract text. Log ids, counts and timings.

## Layout

- `packages/core`: pure TypeScript, no Forge, Node or browser imports, never reads the clock or logs (enforced by `test/purity.test.ts`). Schema, verifier, date engine, extractor (`extract.ts`, one prompt and the `record_contract` tool) and critic (`critic.ts`). Model calls go only through the `LlmClient` interface (`llm.ts`), which also holds `PRODUCTION_MODEL`. Bump `EXTRACTOR_VERSION` when the prompt, tool or checks change.
- `src/parse`: attachment bytes to page text (PDF via `unpdf/pdfjs`, DOCX via mammoth). No Forge imports.
- `src/forge`: resolvers, queue consumer, scheduled trigger, the four actions, SQL repositories, Teamwork Graph client. `src/forge/spikes` is Phase 0 throwaway code.
- `src/frontend`: UI Kit screens.
- `src/forge/tools`: the four Rovo/MCP actions (`list_obligations`, `get_clause`, `get_renewal_brief`, `record_decision`). Input rules live in `packages/core/src/tools.ts`. The agent prompt is `resources/agent/prompt.txt`; the outside-agent skill is `skills/covenant-contracts/SKILL.md`; judge setup steps are `docs/mcp.md`.
- `src/forge/llm`: the production `LlmClient` over Forge LLMs. It must call the model exactly as `eval/src/anthropic-client.ts` does: same model id, temperature 0, one forced tool, same repair wording.
- `eval/`: a workspace that scores `packages/core` against 30 CUAD contracts and writes `eval/report.md`. CUAD files live in `eval/data/`, which git ignores. They never go in git or in the app. Tune prompts on the dev split only (`--dev`).
- `samples/fictional`: an invented contract for tests and demos.
- `docs/spikes.md`: Phase 0 results.

## Platform facts (checked on developer.atlassian.com, 11 Nov 2026)

- UI functions time out at 25 s; actions and rovo:agentConnector at 55 s; queue consumers and scheduled triggers default to 55 s and allow `timeoutSeconds` up to 900. Extraction runs in a queue consumer; the Rovo/MCP Extract tool must enqueue, not run inline.
- One `llm` module and one `rovo:mcp` module per app. Both, and `sql`, are declared from the first deploy because adding `llm` or `sql` later forces a major version.
- Forge LLMs: `@forge/llm` `chat()`; no JSON mode, so structure is forced with one tool plus `tool_choice`. Tool arguments are JSON strings in both directions even though the SDK types say object (spikes S2, S2b); a replayed assistant tool call also needs `content: []`, because `''` becomes an empty text block that the API rejects. The only Haiku is `claude-haiku-4-5-20251001`, past its earliest retirement date; keep the model id in config with `claude-sonnet-4-6` as fallback, and record the model on each run. The eval must use the same model id as production. LLM tokens have no free allowance and are billed to the developer.
- Forge SQL: no foreign keys, no transactions, one statement per query, `?` parameters, SELECT 5 s, request 1 MiB, response 4 MiB. Migrations do not run on deploy: every entry point calls `ensureSchema()` (`src/forge/db/schema.ts`), and new migrations append to its one chain. `INSERT IGNORE` works and `rows.affectedRows` says whether a row went in (verified 12 Nov 2026), so idempotency is a unique key plus `INSERT IGNORE`, and state changes are conditional UPDATEs.
- `@forge/events` 3.x (3.0 only added TypeScript 5 support): events wrapped in `body`; 50 events or 200 KB per push, so pass ids, not text. A consumer that throws is redelivered for up to 24 hours, so the worker records failures on the run instead of throwing.
- Adding a scope is a major version: `forge deploy` stops until run with `--approve MAJOR_VERSION_RULE`, then each site needs `forge install --upgrade`. Consenting to scopes on a site is the developer's decision, not the agent's. Renaming an issue panel's key means re-adding it from the work item's View app actions menu.
- Teamwork Graph (Preview): `api.asUser().requestTeamworkGraph(query, variables, operationName)` only. Operation names are `covenant_<name>` (name 4+ chars). HTTP 200 can carry errors; missing scopes silently drop rows; page until `hasNextPage` is false; never call it from a scheduled or queued function. Client: `src/forge/graph/client.ts`.
  - Introspection (`__type`) works (12 Nov 2026). Fields Covenant uses: `jiraWorkItemGoals(id)` → `AtlassianGoal`, `atlassianTeamsBySpace(spaceAri)` → `AtlassianTeam`, `atlassianTeamMembers(teamAri)` → `AtlassianUser`, `jiraWorkItemComments(id, since)` → `JiraWorkItemComment`. Ids are ARIs: `ari:cloud:jira:<cloudId>:issue/<id>`, `ari:cloud:jira:<cloudId>:project/<id>`. Nodes are unions, so use inline fragments; `User` is an interface (`id`, `name`) and `AtlassianUser` adds `accountId`.
  - There is no curated field for linked work items or incidents: those come from Jira search, as the user.
  - Scopes are per object type: `read:graph:goal:atlassian`, `read:graph:team:atlassian`, `read:graph:issue-comment:jira`, `read:graph:project:jira`, plus the issue and user scopes.
- Dates people see use their calendar: `todayIn(timeZone)` in `src/forge/dates.ts`. The panel and register send the browser's zone; the tools take an optional `timeZone` input and echo the zone used; the daily job has no person and stays on UTC. Jira's `/rest/api/3/myself` (profile time zone) needs `read:jira-user`, which Covenant does not have, and `serverInfo.serverTimeZone` is the server's (`Etc/UTC`), not the user's (checked 13 Nov 2026).
- Personal data (checked 13 Nov 2026): Atlassian's user privacy guidelines require any app storing personal data, account ids included, to report them through the personal data reporting API (`privacy.reportPersonalData` from `@forge/api`, scope `report:personal-data`, at most once per 7-day cycle per account, 90 per request; it rejects with the raw response on anything but 200/204) and to erase closed accounts' data and refresh or erase changed ones. Covenant stores account ids only; `src/forge/jobs/privacy.ts` (run by the daily check) reports them, writes `erased` over closed ones, and purges expired context cache rows (the only place names live). Decision snapshots are depersonalised (`packages/core/src/privacy.ts`). Data an app erases proactively needn't be reported. Forge-hosted storage, SQL included, is soft-deleted on uninstall and deleted after the retention period; relinking is possible within 21 days.
- Attachments: `requestJira` bodies are `string | ArrayBuffer | URLSearchParams`. A hand-built multipart body passed as an `ArrayBuffer`, with `X-Atlassian-Token: no-check`, uploads intact (checked by SHA-256 after download, 12 Nov 2026).
- Pages: the admin page is at `/jira/settings/apps/<appId>/<envId>` and the global page at `/jira/apps/<appId>/<envId>`. A daily `scheduledTrigger` first runs within a day of deploy; the admin page's "Run the daily check now" runs the same code.
- rovo:mcp (Preview): tools are action keys; external access is off until a site or org admin enables it; endpoint `https://mcp.atlassian.com/forge/<appId>`. Spike S4: tools are listed as `<key>_development` outside production, so never hard-code tool names; the caller is `context.principal.accountId` (not in `payload.context`); `api.asUser()` works inside the action and runs as the caller.
- Actions and rovo:agent (checked 12 Nov 2026): `forge lint` rejects an action `description` over 255 characters (YAML `>` adds a newline that counts; use `>-`), so output shapes go in the reply itself, the agent prompt and the skill file. Input types are string, integer, number, boolean. Adding actions and a `rovo:agent` deployed as a minor version (4.1.0). In Rovo chat, a non-GET action shows a "Please review" card with the inputs before it runs. Teamwork Graph via `asUser()` works inside an action (`get_renewal_brief`, 2.3 s with context). The admin's app details page (Apps, Sites, site, Connected apps, View app details) has one TOOLS switch ("Expose tools to MCP-compatible apps") for all of an app's tools, so newly added actions are exposed without another click; the same page has the AI MODELS switch Covenant needs. An MCP client sees the action `description` as the tool description and each input's `description`, `title` and `type` as its JSON schema (`required` becomes the schema's required list); a YAML `>` description keeps a trailing newline, so use `>-`. A Claude app custom connector (Settings, Connectors, Add custom connector, then Atlassian OAuth) works as an outside client and passed the Phase 4 done-when on 12 Nov 2026.
- Anthropic API (eval only): `@anthropic-ai/sdk` 1.x sends API version 2026-10-21, which rejects `temperature`. Production runs Haiku 4.5 at temperature 0, so the eval pins SDK 0.137.0, the last release on 2023-06-01. `claude-haiku-4-5-20251001` is Active on the API at $1/$5 per million tokens (checked 12 Nov 2026).
- unpdf's main entry cannot be bundled by Forge (it calls `import.meta.resolve('pdfjs-dist/...')`); import `getDocument` from `unpdf/pdfjs` instead.

## Environment

- App id `ari:cloud:ecosystem::app/0eb73671-31a0-4410-ae90-4d8ba0607caa`, Developer Space `dheeru-dev`, runtime `nodejs22.x`. Development environment id `3eca07d8-5d61-4154-a3c5-f8da4ce7a188`.
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
npm run check                      # type-check everything and run core and eval tests
npm test                           # core, eval and app tests (test/: Forge code with Jira, SQL and graph faked)
npm run eval                       # score 30 CUAD contracts with the production model; needs ANTHROPIC_API_KEY and eval/data/cuad
npm run eval -- --dev              # 10 separate contracts for prompt work
npm run eval -- --rescore <file>   # rebuild the report from a saved run, no model calls
npm run samples                    # rebuild the fictional sample PDF and DOCX and verify their clauses
npm run spike:local -- <file>      # local fingerprint of a PDF or DOCX, to compare with spike S1
forge deploy -e development
forge install --upgrade --site <site>.atlassian.net --product jira
forge logs -e development
```

## Do not build

Amendments, OCR, Confluence or Jira Service Management screens, Marketplace licensing, or anything that calls an external service from the deployed app.
