# Phase 0 spikes

App `covenant` (id `0eb73671-31a0-4410-ae90-4d8ba0607caa`, Developer Space `dheeru-dev`), development environment,
installed in Jira on the demo site `one-atlas-ykdi.atlassian.net`. Spikes run from the "Covenant spikes" issue panel
(add it to a work item from the work item's **+** menu, then **View app actions**). Each spike also logs its result:
`forge logs -e development`.

## Results

| Spike | Passes when | Result (11 Nov 2026) | Fallback if it fails |
| --- | --- | --- | --- |
| S0 Core inside Forge | `matches` is true (date 2026-11-30) | **Pass.** `packages/core` bundles and runs unchanged; 2 ms. | import core through a build step |
| S1 Attachment text | `bytesSha256` and `textSha256` equal the local values below, for both files | **Pass.** Downloaded as the app with `?redirect=false`; both files byte-identical and text-identical to the local parse. PDF: 29 pages, 0.38 s download, 1.7 s parse. DOCX: 0.41 s download, 0.3 s parse. No corruption. | DOCX and pasted text only |
| S2 Forge LLM | `schemaValid` and `quoteVerified` true, `resolvedDate` 2026-11-30 | **Pass** (second run). Haiku 4.5 via `tool_choice`, valid on the first attempt, quote verified, date 2026-11-30. 1,940 input and 274 output tokens, 2.2 s. | extraction through the Rovo agent |
| S2b Phase 1 extractor (12 Nov) | `status` ok, `effectiveDate` 2025-03-01, `noticeDate` 2026-11-30, every quote verified, `repairCall` has `toolCalled` and `validJson` true | **Pass** (third run, v2.6.0). `extractContract` through `ForgeLlmClient`: 5/5 quotes verified, no second passes, 3,695 input and 670 output tokens. The forced repair turn returned a valid tool call (`stopReason` `tool_use`). 6.3 s for both calls. The first two runs failed on the repair turn; see below. | none needed; the adapter is fixed |
| S3 Teamwork Graph | no error, `rows` equals your assigned work items | **Pass.** Curated `atlassianUserAssignedJiraWorkItems` as the signed-in user: 1 page, 1 row, `MOBL-57`, matching the 1 item assigned in Jira; 0.9 s. | Jira search for owner hints, withdraw the graph entry |
| S4 MCP | deploys with `rovo:mcp`; an outside client lists and calls `covenant-ping` | **Pass.** After an admin enabled tools, MCP Inspector 1.0.3 connected over Streamable HTTP with OAuth, listed the tool as `covenant-ping_development` with its `note` input, and called it. The action ran as the calling user: `api.asUser()` Jira search returned 200 with the user's 1 assigned item. | bonus target becomes the Rovo agent |
| S5 Forge SQL | `roundTrip` is true | **Pass.** Migration `v001_create_spike_probe` applied, insert and select round-trip; 1.1 s. | key-value store, one record per contract |

## What we learned

- **Forge LLM tool arguments arrive as a JSON string**, although the `@forge/llm` types say `object`. Always accept both.
- **Sending a tool call back (the repair turn) needs two things the `@forge/llm` types do not say** (S2b):
  - `function.arguments` must be a JSON string. An object fails with HTTP 400 "Cannot deserialize value of type `java.lang.String` from Object value".
  - The assistant message needs `content: []`. `content: ''` becomes an empty text block and fails with HTTP 400 "text content blocks must be non-empty". With no parts, the turn holds only the tool call, the same as the eval's Anthropic `tool_use` turn.
- **The first S2 run failed validation**: the model attached a `recurrence` to a `term_end` deadline because the contract renews. The schema rejected it, as it should. Field descriptions in the JSON schema (now enforced by a test) plus one prompt sentence fixed it. The extractor keeps one repair turn that sends validation errors back as the tool result.
- **`list()` reports eight active models**, Haiku 4.5 included: `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-5`.
- **unpdf's main entry cannot be bundled by Forge** (`import.meta.resolve('pdfjs-dist/...')`). `getDocument` from `unpdf/pdfjs` works.
- **The Teamwork Graph curated query shape from the community write-up is correct**: `atlassianUserAssignedJiraWorkItems(userId, first, after)` with a `JiraWorkItem` fragment and `pageInfo`. The ARI is `ari:cloud:identity::user/<accountId>`. Scopes used: `read:graph:issue:jira`, `read:graph:issue-status:jira`, `read:graph:user:atlassian`.
- **The demo site's seeded data had nothing assigned to you**, so MOBL-57 was assigned to you for S3. A judge's clean site will look the same: owner suggestions must work with an empty graph.
- **Forge CLI prompts** (Developer Space, terms) need a real terminal. Never run `forge create` in this folder.
- **The built-in browser pane in the Claude app cannot upload files.** Attach files to Jira from a normal browser.
- **Binary attachments arrive intact** when a backend function reads `/rest/api/3/attachment/content/{id}?redirect=false` with `arrayBuffer()`. A 29-page PDF downloads and parses in about 2 s, well inside the 25 s UI limit, but extraction still belongs in the queue consumer because the model calls come on top.
- **Over MCP, tool names carry the environment**: the action `covenant-ping` is listed as `covenant-ping_development`. Production should drop the suffix; check that after the first production deploy, and never hard-code tool names in the Rovo agent prompt or the demo script.
- **What an MCP tool call hands the action** (key names only, from the ping):
  - `payload`: `context`, `contextToken`, plus the declared inputs. `payload.context` holds `cloudId`, `moduleKey`, `userAccess`, with no work item and no account id.
  - `context`: `installContext`, `installation`, `principal`, `workspaceId`. The caller is `context.principal.accountId`. The Rovo action docs say the account id is in the payload context; over MCP it is not.
- **MCP tool calls run as the calling user.** `api.asUser().requestJira` works inside the action; a `currentUser()` search returned the caller's own items. The four Phase 4 actions can therefore create work items as the user, with the user's own Jira permissions.
- **Enabling tools is per site, in Atlassian Administration**: Apps, Sites, the site, Connected apps, the app's details, TOOLS, **Enable tools**. The first click did not save; reload the page and check that it says Enabled. The same page lets an admin turn off **Access to Atlassian-hosted AI models** for the app, so the Phase 3 preflight must check for that.
- **The OAuth consent screen says the app gets "Read, Write and Search"** although Covenant asks only for read scopes. The wording looks generic; mention it in the judges' setup notes so it does not look like overreach.
- **MCP Inspector 2.x needs Node 22.19 or later** (2.14.0 needs 22.23.4). On this machine's Node 22.15 use `npx @modelcontextprotocol/inspector@1.0.3`. Its Streamable HTTP plus OAuth flow works with `mcp.atlassian.com`.

## S1: local values it was checked against

From `npm run spike:local -- <file>`; S1 on Forge (MOBL-57, 11 Nov 2026) returned the same values:

| File | Bytes | bytesSha256 | Pages | textSha256 |
| --- | --- | --- | --- | --- |
| `tallowmere-quillfeather-msa.pdf` | 73,696 | `b63701409d18959b254e60509afd2acb833c5c099d00313f65c283b398483562` | 29 | `9cb57beff04055f9393bc37e422c1ef26685b83577b92046e83df1dd99335336` |
| `tallowmere-quillfeather-msa.docx` | 16,162 | `1abc1a1684c4f3048f2d0ddc5eb7b31afad2a43472d2b45925507d21a402325b` | 1 | `9508191a4c5eb72564c3ad877bdbd40fefbea74b53451106b2c2774d21c6873a` |

## S4: how to repeat it

1. In Atlassian Administration, go to Apps, then Sites, then `one-atlas-ykdi`, then Connected apps. Open Covenant's details and, under TOOLS, click **Enable tools**. Reload and check it says Enabled.
2. Run `MCP_AUTO_OPEN_ENABLED=false npx @modelcontextprotocol/inspector@1.0.3` and open the link it prints (it carries a session token). Choose Streamable HTTP, URL `https://mcp.atlassian.com/forge/0eb73671-31a0-4410-ae90-4d8ba0607caa`, and click Connect.
3. On Atlassian's consent screen, check the site is `one-atlas-ykdi` and Accept.
4. Tools tab: **List Tools**, pick `covenant-ping_development`, **Run Tool**. The result and `forge logs -e development` (line `spike s4 ping ...`) show key names, the caller's source path and the `asUser` status. Never values.

Result on 11 Nov 2026: `callerSource=context.principal.accountId`, `principalKeys=accountId`, `payloadContextKeys=cloudId,moduleKey,userAccess`, `asUser={"status":200,"rows":1}`.

## Known unknowns

- Whether production drops the `_development` suffix from tool names.
- Forge CLI 14.2.0 is installed because 15.x needs Node 22.23.4 or later and this machine has 22.15.0.
- `claude-haiku-4-5-20251001` is past its earliest retirement date (15 Oct 2026) but still active. Fallback: `claude-sonnet-4-6`.
