# Devpost submission draft: Covenant

Draft text for the Codegeist 2026 form. The `[...]` placeholders are filled in on submission day.

- **Project name:** Covenant
- **Tagline:** Contract obligations as dated, owned, clause-cited Jira work items.
- **Category:** Apps for Business Teams
- **Bonus prizes entered:** Best app with Atlassian MCP; Best Agents (Rovo); Best apps with Teamwork Graph integration
- **Installation link:** [from the developer console's Distribution page]
- **Video:** [YouTube link, public, under 5 minutes]
- **Code:** https://github.com/Dheeru-Reddy-ui/covenant (MIT)
- **Testing instructions:** the "Install and try it" section of the README, repeated below

---

## Inspiration

Most companies keep their contracts in a drive and their work in Jira. The two never meet, so the dates that matter fall through the gap: the 90 days' notice before an auto-renewal, the insurance certificate due a month after each anniversary, the price-change notice. Contract tools exist, but they live apart from the work. The people who end up acting on a contract, such as procurement, finance, legal ops and the owner of the supplier relationship, already work in Jira.

AI can read a contract, but a deadline from an AI is only useful if you can trust it. A model that writes "2026-12-02" might have done the arithmetic wrong, or quoted a clause that isn't in the contract. Covenant is built so that every date can be checked by anyone who reads it.

## What it does

Attach a contract (a text PDF or Word file) to a Jira work item and click **Extract**.

- **Obligations with their evidence.** Covenant lists each obligation with the verbatim clause it came from and where it sits, for example "clause 1.2 (Term and renewal), page 4". Each one has a plain rule ("90 days before the end of the current term") and a due date, and the panel shows how the date was worked out.
- **A person decides.** Each obligation is approved, edited or rejected. Approving creates a child work item with the due date set, a link back to the clause, and the arithmetic in its description. Nothing is written to Jira until someone approves it.
- **Renewal decisions before the window closes.** A daily check opens a **Decision due** work item when a notice deadline comes within the lead time (60 days by default). The renewal brief shows:
  - the countdown and the governing clause;
  - past decisions;
  - the dates that move if the contract renews;
  - from Teamwork Graph and Jira: related work, incidents, goals, the space's teams, and suggested owners, each with the evidence behind the suggestion.

  Record renew, renegotiate or terminate with a rationale, and Covenant stores a snapshot of what the decision was based on. **Mark renewed** starts the next term and every dependent date moves on screen.
- **A portfolio register** lists every obligation by due date, with 30, 60 and 90 day views and flags for "inside notice window", "no owner" and "overdue". It shows only contracts the viewer can see in Jira.
- **The same answers in chat.** A Rovo agent and an MCP server answer questions like "which notice deadlines fall in the next 90 days?", with the clause behind every date. They can also brief a person on a renewal and record their decision, but only after the person confirms.
- **An admin page** runs a preflight of every dependency and loads a sample workspace of three fictional contracts, so the app can be tried in minutes.

## How I built it

Covenant is built only on Forge, and nothing calls an external service. It is eligible for Runs on Atlassian.

| Need | Forge |
| --- | --- |
| Reading the contract | **Forge LLMs** (`llm` module, Claude Haiku 4.5) with one forced tool call, at temperature 0 |
| Long-running extraction | **Async events** queue consumer with a 900-second timeout. The Extract button only queues the job |
| Storage | **Forge SQL**: contracts, runs, clauses, obligations, decisions, context cache. Idempotency comes from unique keys and conditional updates, since Forge SQL has no transactions |
| UI | **UI Kit**: `jira:issuePanel`, `jira:globalPage` (register) and `jira:adminPage` (preflight, sample workspace) |
| Daily decision check | `scheduledTrigger` |
| Context | **Teamwork Graph API**, as the signed-in user, with operation-name prefixes, full paging, backoff and errors reported per section |
| Chat and outside agents | `rovo:agent`, four `action` modules and `rovo:mcp` |

The design rule is that the model reads and code decides:
1. The extractor returns structured rules, never dates: who, what, measured from which event, by how much.
2. A verifier drops any quote that isn't in the file word for word, spacing aside.
3. A deterministic date engine turns rules into dates. It has unit and property-based tests and handles term ends, anniversaries, business days, recurrences and leap years.
4. Code also derives the page and the clause number from where the quote sits; the model's page number is only a hint.
5. Doubtful readings get a second pass, and when the passes disagree, the obligation is flagged for a person instead of guessed.

I measured it on 30 contracts from the public CUAD dataset with the production model:
- **93.3%** of notice periods matched exactly (14/15);
- **100%** of the values Covenant gave were right, across 58 answers on four fields; it withheld a value for review when unsure;
- **95.5%** of the quotes the model returned were found verbatim, and the rest were dropped.

There are 410 tests: 372 for the core, 19 for the eval and 19 for the app. The app tests check that a user who cannot see a contract gets nothing from any tool, and that no log line can contain contract text.

## How it meets the Forge requirement

Covenant is a Forge app (`manifest.yml`, runtime nodejs22.x) that integrates with Jira, through the issue panel, global page, admin page, work items and comments, and with Rovo and Teamwork Graph. It uses Forge LLMs, Forge SQL, async events, a scheduled trigger, UI Kit, `rovo:agent`, `action` and `rovo:mcp`. Every byte of contract text stays on the Atlassian platform.

## Category: Apps for Business Teams

Contracts belong to legal, procurement and finance, but their deadlines land on everyone. Covenant gives those teams the context to act decisively:
- the clause in front of them;
- the date already worked out and checked;
- the owner suggested from real activity;
- the decision recorded where the work happens.

## Bonus prizes

**Best app with Atlassian MCP.** Covenant's `rovo:mcp` module exposes four tools: `list_obligations`, `get_clause`, `get_renewal_brief` and `record_decision`.
- Each description tells a model when to use the tool, its output and its limits, within Forge's 255-character cap. Every input is described, and every reply explains its own fields.
- The tools run as the caller and see only contracts on work items the caller can see. A hidden contract gives the same answer as a missing one, and a test proves it.
- `record_decision` is a two-step write: without `confirm: true` it returns a preview and writes nothing.
- An open-source `skills/covenant-contracts/SKILL.md` (MIT) teaches outside agents the workflow and the trust rules: never recalculate a date, quote every clause, say what is unconfirmed.

I tested it with an outside MCP client, a Claude app custom connector. Asked "which notice deadlines fall in the next 90 days?", it answered with four deadlines, each with its clause and location. `docs/mcp.md` has the admin enablement steps.

**Best Agents.** The `rovo:agent` "Covenant contract assistant" has a role prompt in a resource file, four conversation starters, and the same four actions. In Rovo chat it lists deadlines with citations and chains `list_obligations` into `get_clause` for exact wording. It briefs a renewal with Teamwork Graph context, and it records a decision only after Rovo's review card and the tool's own confirmation step.

**Best apps with Teamwork Graph integration.** The renewal brief reads, as the signed-in user:
- goals linked to the contract's work item (`jiraWorkItemGoals`);
- teams on its space (`atlassianTeamsBySpace`) and their members (`atlassianTeamMembers`);
- comments on related work (`jiraWorkItemComments`).

Owner suggestions rank people by assignee, commenter, goal-owner and team evidence, and show the evidence beside each name. The client prefixes operation names, pages until `hasNextPage` is false, backs off on rate limits, and reports a section that failed rather than showing it as empty. Results are cached per contract and per person, because the graph filters by each reader's permissions.

## Challenges I ran into

- **Dates you can trust.** "90 days before the end of the then-current term" depends on when a term ends: the anniversary, or the day before it. Covenant uses the day before by default, which can only make a deadline a day early, never late, and it says so on screen.
- **Forge LLMs quirks.** Tool-call arguments travel as JSON strings even though the SDK types say object, and a replayed assistant turn needs `content: []`. I found both with small spikes before building on them.
- **No transactions.** Forge SQL has no transactions, so every state change is a conditional update or an `INSERT IGNORE` on a unique key. Clicking Extract twice, or approving twice, creates nothing new.
- **Word files have no pages.** So Covenant locates quotes by clause number, worked out by code from the numbering around the quote.

## Accomplishments that I'm proud of

- In the measured run, every value Covenant gave was right (58/58), because it withholds a value instead of guessing.
- A judge can install it and see a full portfolio in minutes, from the sample workspace.
- The same trust rules hold in the panel, the Rovo agent, an outside MCP client and the skill file.

## What I learned

- Forge's async events, Forge SQL and Forge LLMs together are enough for a serious document pipeline with no external services.
- Keeping a pure core with no Forge imports made it possible to evaluate the exact production code against CUAD outside Forge.

## What's next for Covenant

- Linking amendments to the agreements they amend.
- Jira Service Management request intake for new contracts.
- A Marketplace listing.

## Built with

Atlassian Forge, Forge LLMs (Claude Haiku 4.5), Forge SQL, async events, UI Kit, Rovo (`rovo:agent`, `rovo:mcp`, `action`), Teamwork Graph API, Jira REST API, TypeScript, zod, unpdf (PDF.js), mammoth, vitest and fast-check.

## Testing instructions

[Paste the "Install and try it" section of the README here, and add:]

- You need to be a site admin to install. Rovo is optional. An organization admin is needed only to expose the MCP tools to outside clients.
- The sample workspace needs one Jira project you can create work items in. Any template works.
- Model usage is billed to the developer, so judges pay nothing.
