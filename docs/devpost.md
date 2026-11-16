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
  - "Why this date": the rule the model read and each step code took, including the contract's holiday calendar;
  - how to give notice: the notice address and delivery methods, quoted, with the latest send date per method from its deemed-receipt rule, and a drafted notice labelled as a draft for legal review;
  - what is at stake: the contract's value, quoted and confirmed by a person, with code doing every sum;
  - the supplier's record this term: the contract's own service levels measured against the supplier's incidents in Jira, breaches, credits still claimable with their claim deadline, and a drafted claim;
  - from Teamwork Graph and Jira: related work, incidents, goals, the space's teams, and suggested owners, each with the evidence behind the suggestion. Items Covenant created itself never count as history.

  Record renew, renegotiate or terminate with a rationale: Covenant stores a snapshot of what the decision was based on, resolves the Decision due item, and when notice must be given opens a "Send notice by" item with the drafted letter. **Mark renewed** starts the next term and every dependent date moves on screen.
- **Evidence on receipt.** When the supplier's insurance certificate or report is attached to the obligation's work item, Covenant checks it against the clause: the expiry covers the required period, the named party matches, and each requirement is met. It shows pass, fail or needs review with quotes from both documents, and drafts a chase message on a fail.
- **A portfolio register** leads with the money auto-renewing in the next 90 days, charts notice deadlines and contract value by month, and lists every obligation by due date with 30, 60 and 90 day views and flags for "inside notice window", "no owner" and "overdue". It shows only contracts the viewer can see in Jira.
- **The same answers in chat.** A Rovo agent, guided by a Rovo skill for the renewal review, and an MCP server answer questions like "which notice deadlines fall in the next 90 days?", with the clause behind every date. They can also brief a person on a renewal and record their decision, but only after the person confirms. A written Jira Automation recipe runs the agent on every new Decision due item.
- **An admin page** runs a preflight of every dependency, sets up a Contracts project with three fictional contracts in one click, and shows a quality panel (the eval scores and the share of obligations approved unedited) and the AI access log: who read which clause, when and through which channel.

## How I built it

Covenant is built only on Forge, and nothing calls an external service. It is eligible for Runs on Atlassian.

| Need | Forge |
| --- | --- |
| Reading the contract | **Forge LLMs** (`llm` module, Claude Haiku 4.5) with one forced tool call, at temperature 0 |
| Long-running extraction | **Async events** queue consumer with a 900-second timeout. The Extract button only queues the job |
| Storage | **Forge SQL**: contracts, runs, clauses, obligations, decisions, contract details, evidence checks, the access log, context cache. Idempotency comes from unique keys and conditional updates, since Forge SQL has no transactions |
| UI | **UI Kit**: `jira:issuePanel`, `jira:globalPage` (register with `BarChart`s) and `jira:adminPage` (preflight, one-click setup, quality, access log) |
| Daily decision check | `scheduledTrigger` |
| Evidence on receipt | `trigger` on `avi:jira:created:attachment` |
| Context | **Teamwork Graph API**, as the signed-in user, with operation-name prefixes, full paging, backoff and errors reported per section |
| Chat and outside agents | `rovo:agent`, `rovo:skill`, four `action` modules and `rovo:mcp` |

The design rule is that the model reads and code decides:
1. The extractor returns structured rules, never dates: who, what, measured from which event, by how much.
2. A verifier drops any quote that isn't in the file word for word, spacing aside.
3. A deterministic date engine turns rules into dates. It has unit and property-based tests and handles term ends, anniversaries, business days, recurrences and leap years.
4. Code also derives the page and the clause number from where the quote sits; the model's page number is only a hint.
5. Doubtful readings get a second pass, and when the passes disagree, the obligation is flagged for a person instead of guessed.
6. Money is copied as text from inside a verified quote and parsed by code; the model never totals anything. Notice addresses, values and evidence findings pass the same verbatim check.
7. Contract text is data: clauses that read like instructions to an AI are flagged, tool replies keep contract text in marked quote fields, and a test proves a planted clause is not followed.

I measured it on 30 contracts from the public CUAD dataset with the production model:
- **93.3%** of notice periods matched exactly (14/15);
- **100%** of the values Covenant gave were right, across 57 answers on four fields; it withheld a value for review when unsure;
- **96.4%** of the quotes the model returned were found verbatim, and the rest were dropped.

Twenty invented trap contracts (conflicting notice periods, dates in words, two-digit years, a planted instruction, a planted fee and more) all pass. CI fails the build if fewer traps pass than a recorded baseline, and the CUAD run has the same gate locally. To prove it, a prompt telling the model to obey the contract let the planted fee through and the build failed; everything else held, because code checks every quote and computes every date.

There are 550 tests: 484 for the core, 25 for the eval and 41 for the app. The app tests check that a user who cannot see a contract gets nothing from any tool, a planted clause is not followed, every read is logged with ids only, and no log line can contain contract text.

## How it meets the Forge requirement

Covenant is a Forge app (`manifest.yml`, runtime nodejs22.x) that integrates with Jira, through the issue panel, global page, admin page, work items and comments, and with Rovo and Teamwork Graph. It uses Forge LLMs, Forge SQL, async events, a scheduled trigger, a product event trigger, UI Kit, `rovo:agent`, `rovo:skill`, `action` and `rovo:mcp`. Every byte of contract text stays on the Atlassian platform.

## Category: Apps for Business Teams

Contracts belong to legal, procurement and finance, but their deadlines land on everyone. Covenant gives those teams the context to act decisively:
- the clause in front of them;
- the date already worked out and checked, with the latest day to send notice;
- what the contract is worth and what the supplier actually delivered;
- the owner suggested from real activity;
- the decision recorded where the work happens, with the notice drafted.

## Bonus prizes

**Best app with Atlassian MCP.** Covenant's `rovo:mcp` module exposes four tools: `list_obligations`, `get_clause`, `get_renewal_brief` and `record_decision`.
- Each description tells a model when to use the tool, its output and its limits, within Forge's 255-character cap. Every input is described, and every reply explains its own fields.
- The tools run as the caller and see only contracts on work items the caller can see. A hidden contract gives the same answer as a missing one, and a test proves it.
- `record_decision` is a two-step write: without `confirm: true` it returns a preview and writes nothing. It also refuses to record against a notice deadline no person has reviewed.
- An open-source `skills/covenant-contracts/SKILL.md` (MIT) teaches outside agents the workflow and the trust rules: never recalculate a date, quote every clause, say what is unconfirmed.

I tested it with an outside MCP client, a Claude app custom connector. Asked "which notice deadlines fall in the next 90 days?", it answered with four deadlines, each with its clause and location. `docs/mcp.md` has the admin enablement steps.

**Best Agents.** The `rovo:agent` "Covenant contract assistant" has a role prompt in a resource file, four conversation starters, the same four actions, and a `rovo:skill` (`covenant-renewal-review`) that packages the renewal review workflow over them. In Rovo chat it lists deadlines with citations and chains `list_obligations` into `get_clause` for exact wording and "why this date". It briefs a renewal with notice send-by dates, value, the supplier's record and Teamwork Graph context, and it records a decision only after Rovo's review card and the tool's own confirmation step. `docs/automation.md` gives the Jira Automation rule that runs it on every new Decision due item. I checked whether it can be assigned a work item: Forge agents cannot be yet, so Automation is the route.

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

- In the measured run, every value Covenant gave was right (57/57), because it withholds a value instead of guessing.
- A judge can install it and see a full portfolio in minutes, from the sample workspace.
- The same trust rules hold in the panel, the Rovo agent, an outside MCP client and the skill file.

## What I learned

- Forge's async events, Forge SQL and Forge LLMs together are enough for a serious document pipeline with no external services.
- Keeping a pure core with no Forge imports made it possible to evaluate the exact production code against CUAD outside Forge.

## What's next for Covenant

- Linking amendments to the agreements they amend (cut from this version to make room for the decision and evidence work).
- A Teamwork Graph connector for outside contract systems.
- Assigning work items to the agent, once Forge agents support it.
- Jira Service Management request intake for new contracts, and a Marketplace listing.

## Built with

Atlassian Forge, Forge LLMs (Claude Haiku 4.5), Forge SQL, async events, UI Kit, Rovo (`rovo:agent`, `rovo:skill`, `rovo:mcp`, `action`), Teamwork Graph API, Jira REST API, Jira Automation, TypeScript, zod, unpdf (PDF.js), mammoth, docx, vitest and fast-check.

## Testing instructions

[Paste the "Install and try it" section of the README here, and add:]

- You need to be a site admin to install. Rovo is optional. An organization admin is needed only to expose the MCP tools to outside clients.
- One-click setup creates its own Contracts project, so it works on an empty site; if a Contracts project already exists, the new one is called "Contracts (Covenant)". The sample workspace instead needs one Jira project you can create work items in.
- The install screen asks to manage Jira configuration. Only one-click setup uses it, to create its project and add the Contract, Task and Subtask work types. Every permission is explained in PRIVACY.md.
- Model usage is billed to the developer, so judges pay nothing.
