# Phase 0 spikes

App `covenant` (id `0eb73671-31a0-4410-ae90-4d8ba0607caa`, Developer Space `dheeru-dev`), development environment,
installed in Jira on the demo site `one-atlas-ykdi.atlassian.net`. Spikes run from the "Covenant spikes" issue panel
(add it to a work item from the work item's **+** menu, then **View app actions**). Each spike also logs its result:
`forge logs -e development`.

## Results

| Spike | Passes when | Result (11 Nov 2026) | Fallback if it fails |
| --- | --- | --- | --- |
| S0 Core inside Forge | `matches` is true (date 2026-11-30) | **Pass.** `packages/core` bundles and runs unchanged; 2 ms. | import core through a build step |
| S1 Attachment text | `bytesSha256` and `textSha256` equal the local values below, for both files | **Not run yet.** Needs both sample files attached to MOBL-57. | DOCX and pasted text only |
| S2 Forge LLM | `schemaValid` and `quoteVerified` true, `resolvedDate` 2026-11-30 | **Pass** (second run). Haiku 4.5 via `tool_choice`, valid on the first attempt, quote verified, date 2026-11-30. 1,940 input and 274 output tokens, 2.2 s. | extraction through the Rovo agent |
| S3 Teamwork Graph | no error, `rows` equals your assigned work items | **Pass.** Curated `atlassianUserAssignedJiraWorkItems` as the signed-in user: 1 page, 1 row, `MOBL-57`, matching the 1 item assigned in Jira; 0.9 s. | Jira search for owner hints, withdraw the graph entry |
| S4 MCP | deploys with `rovo:mcp`; an outside client lists and calls `covenant-ping` | **Half done.** The `rovo:mcp` module and the `covenant-ping` action deploy and pass manifest validation. External listing and calling not tried yet (needs admin enablement). | bonus target becomes the Rovo agent |
| S5 Forge SQL | `roundTrip` is true | **Pass.** Migration `v001_create_spike_probe` applied, insert and select round-trip; 1.1 s. | key-value store, one record per contract |

## What we learned

- **Forge LLM tool arguments arrive as a JSON string**, although the `@forge/llm` types say `object`. Always accept both.
- **The first S2 run failed validation**: the model attached a `recurrence` to a `term_end` deadline because the contract renews. The schema rejected it, as it should. Field descriptions in the JSON schema (now enforced by a test) plus one prompt sentence fixed it. The extractor keeps one repair turn that sends validation errors back as the tool result.
- **`list()` reports eight active models**, Haiku 4.5 included: `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-5`.
- **unpdf's main entry cannot be bundled by Forge** (`import.meta.resolve('pdfjs-dist/...')`). `getDocument` from `unpdf/pdfjs` works.
- **The Teamwork Graph curated query shape from the community write-up is correct**: `atlassianUserAssignedJiraWorkItems(userId, first, after)` with a `JiraWorkItem` fragment and `pageInfo`. The ARI is `ari:cloud:identity::user/<accountId>`. Scopes used: `read:graph:issue:jira`, `read:graph:issue-status:jira`, `read:graph:user:atlassian`.
- **The demo site's seeded data had nothing assigned to you**, so MOBL-57 was assigned to you for S3. A judge's clean site will look the same: owner suggestions must work with an empty graph.
- **Forge CLI prompts** (Developer Space, terms) need a real terminal. Never run `forge create` in this folder.

## S1: how to finish it

1. Attach both files from `samples/fictional/` to MOBL-57.
2. In the Covenant spikes panel, run S1.
3. Compare with these local values (from `npm run spike:local -- <file>`):

| File | Bytes | bytesSha256 | Pages | textSha256 |
| --- | --- | --- | --- | --- |
| `tallowmere-quillfeather-msa.pdf` | 73,696 | `b63701409d18959b254e60509afd2acb833c5c099d00313f65c283b398483562` | 29 | `9cb57beff04055f9393bc37e422c1ef26685b83577b92046e83df1dd99335336` |
| `tallowmere-quillfeather-msa.docx` | 16,162 | `1abc1a1684c4f3048f2d0ddc5eb7b31afad2a43472d2b45925507d21a402325b` | 1 | `9508191a4c5eb72564c3ad877bdbd40fefbea74b53451106b2c2774d21c6873a` |

## S4: how to finish it

1. In Atlassian Administration, go to Apps, then Sites, then `one-atlas-ykdi`, then Connected apps. Open Covenant and turn on external MCP access and the `covenant-ping` tool.
2. Point an MCP client at `https://mcp.atlassian.com/forge/0eb73671-31a0-4410-ae90-4d8ba0607caa` and complete its OAuth consent (pick the demo site).
3. List tools, then call `covenant-ping`. The call logs the shape of the payload and context it received (key names only) to `forge logs`.

## Known unknowns

- What `context` an action receives over MCP, and whether it runs as the calling user. S4's ping logs the key names to find out.
- Forge CLI 14.2.0 is installed because 15.x needs Node 22.23.4 or later and this machine has 22.15.0.
- `claude-haiku-4-5-20251001` is past its earliest retirement date (15 Oct 2026) but still active. Fallback: `claude-sonnet-4-6`.
