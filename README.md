# Covenant

**Never miss a contract renewal deadline.** Covenant turns a contract's obligations into dated, owned, clause-cited Jira work items. Every date is worked out by code and every clause is quoted, so anyone can check it. A Forge app for Jira, built for Atlassian Codegeist 2026 (Apps for Business Teams).

Attach a contract (a text PDF or a Word file) to a Jira work item and click **Extract**. Covenant finds the contract's obligations: renewal and termination notice deadlines, payments, price changes, reports, audit and insurance duties, and service credits. Each one comes with the verbatim clause it came from and where it sits ("clause 1.2 (Term and renewal), page 4"). A person approves, edits or rejects each one. Approving creates a child work item with the due date already set.

Before a renewal notice window closes, Covenant opens a **Decision due** work item. The renewal brief puts the contract's terms next to the team's real Jira data:

- **The deadline and why.** The notice deadline, the governing clause, and "Why this date": the rule the model read and each step code took, including the contract's holiday calendar.
- **How to give notice.** The notice address and delivery methods, quoted from the contract, with the latest send date for each method worked out from its deemed-receipt rule. A drafted notice, labelled as a draft for legal review, and a "Send notice by" work item.
- **What is at stake.** The contract's value, quoted and confirmed by a person. Code does the sums: the register leads with the total value auto-renewing in the next 90 days, with charts of notice deadlines and value by month.
- **What the supplier delivered.** The contract's own service levels measured against the supplier's incidents in Jira (a JQL filter per contract): incident counts and resolution times, breaches, service credits still claimable with their claim deadline, and a "Claim service credit by" work item with a drafted claim. A leverage summary when the decision is "renegotiate".
- **Who should own it.** Related work, goals and teams from Jira and Teamwork Graph, and suggested owners with their evidence. Work items Covenant created itself never count as history.

Record the decision with a rationale: the brief shows it, the Decision due item is resolved, and when the decision means notice must be given (terminating a contract that auto-renews), the "Send notice by" item opens with the drafted letter. When a supplier sends a certificate or report, attach it to the obligation's work item: Covenant checks it against the clause (expiry, named party, each requirement) and shows pass, fail or needs review with quotes from both documents, plus a drafted chase message on a fail.

A Rovo agent with a Rovo skill, and an MCP server, answer the same questions from chat, citing the clause behind every date.

## For the judges

| Prize | What to look at |
| --- | --- |
| Apps for Business Teams | Install steps 3 to 8 below: one-click setup, a contract's obligations with their clauses, the renewal brief, a certificate check, the register |
| Best app with Atlassian MCP | Four real tools from any MCP client, as the caller, under the same trust rules as the panel; `record_decision` writes nothing until the person confirms ([docs/mcp.md](docs/mcp.md)) |
| Best Agents (Rovo) | The Covenant agent and its renewal-review skill in Rovo chat, and an Automation recipe that has it brief every new Decision due item ([docs/automation.md](docs/automation.md)) |
| Best apps with Teamwork Graph integration | The renewal brief's goals, teams, members and comments, read as the viewer, ranked into suggested owners with the evidence beside each name |

## Why you can trust it

- **The model never computes a date or a sum.** It reads the contract and returns rules and quoted amounts. Tested code works out every date and every total.
- **Every quote is checked.** A quote that does not appear word for word in the file, spacing aside, is dropped with what it supports: obligations, notice addresses, contract values and evidence findings alike. Code, not the model, works out the page and clause number.
- **Doubt goes to a person.** Unsure readings are read a second time; if the readings disagree, the item is flagged rather than guessed. A notice deadline whose clause never mentions the term is flagged too, since it may be a right to terminate on notice. An unreadable certificate is "needs review", never a pass.
- **Contract text is data, never instructions.** Clauses that read like instructions to an AI are flagged in the panel and in every tool reply, quoted text comes back only in marked fields, and tests prove a planted clause is not followed.
- **Nothing reaches Jira without a person.** Work items and comments are created only on a person's click, and the write tool refuses unless the person confirms, and never records a decision against a notice deadline no one has reviewed. The one exception is the reminder: once someone has extracted a contract, the daily check opens its Decision due item when the notice window nears.
- **Every AI read is logged.** Each clause read through the panel, the agent or MCP is logged with who, when and which channel (never the text), and admins can see the log.
- **Contract text never leaves Atlassian and never goes in a log.** The model is Atlassian-hosted Claude through Forge LLMs, data lives in Forge SQL, and logs hold ids, counts and timings only. The app is eligible for Runs on Atlassian.
- **Personal data is kept to account ids and reported** through Atlassian's personal data reporting API. See [PRIVACY.md](PRIVACY.md).

## Install and try it (about 10 minutes)

You need a Jira Cloud site where you are a site admin. Rovo is optional. Turning on the MCP tools for outside clients needs an organization admin.

1. **Install.** Open the installation link from the submission and click **Get app**. Choose your site, review the permissions, and click **Install**. [PRIVACY.md](PRIVACY.md#permissions) says what each permission is for; the broadest, managing Jira configuration, is used only by one-click setup, to create its project and work types.
2. **Open the admin page.** In Jira, open **Settings** (the gear at the top right), then **Marketplace apps**. In the settings sidebar, under **Apps**, click **Covenant**. The first time, it takes about 15 seconds while Covenant sets up its database. **Preflight** checks the database, the model, Jira, Teamwork Graph and the daily check.
3. **Set up in one click.** Under **One-click setup**, click **Set up Covenant**. It creates a **Contracts** project (key COVN; called **Contracts (Covenant)** if your site already has a Contracts project) with a **Contract** work type and loads three fictional contracts, each with its Word file, plus related tasks and incidents. Clicking it again changes nothing. On a site that already has projects, you can instead use **Sample workspace** and pick a project. Notice deadlines fall about 20, 50 and 85 days from today. Extraction uses a few cents of model tokens, billed to the app's developer, not to you; each site may ask for up to 60 document readings a day.
4. **Open a contract.** Open **Contract: Quillfeather Systems route planning MSA** (COVN-1; the admin page links to it under Sample workspace). Its extraction runs by itself and takes under a minute. If you don't see the Covenant panel, open the work item's **View app actions** menu and choose **Covenant**. The panel opens with a card: the notice deadline, the one step to take next, and a button for it. The other sections fold to one line each; click **Show** to open one.
5. **Review.** Under **Obligations**, each obligation shows its clause, its rule and its due date; click **Why this date** to see the working. Click **Approve and create work item** on one. Under **Notices, value and supplier record**, in **Giving notice**, choose which party you are and confirm the delivery methods; in **Contract value**, confirm the value so the register can count it.
6. **Decide on the renewal.** In **Renewal decision** (open from the start while a decision is due), load the related work and suggested owners, look at the supplier record and the send-by dates, open the drafted notice, then **Record decision**.
7. **Check a certificate.** Approve the insurance obligation, open the work item it creates (under the contract's **Subtasks**), and open its Covenant panel from **View app actions**. Click **Attach a certificate that should pass**, then **Attach one with problems**: the second fails on the named party, the limit and its expiry, and drafts a chase message.
8. **See the portfolio.** Open **Apps** in Jira's sidebar, then **Covenant register**: the money auto-renewing in 90 days, the charts, and every obligation by due date. Mark an obligation's work item done in Jira and the register shows it as Done; a recurring duty, such as a quarterly report, moves on to its next date, and the finished item's Covenant panel offers to open the work item for that date.
9. **Get the Decision due items.** The daily check opens them within a day of installing; **Run the daily check now** on the admin page runs it at once. The admin page also shows the **Quality** panel and the **AI access log**.
10. **Ask Rovo** (if your site has Rovo). Open Rovo chat, choose **Covenant contract assistant**, and ask *Brief me on the Quillfeather renewal*. To have the agent brief every new Decision due item, follow [docs/automation.md](docs/automation.md).
11. **Use an outside MCP client** (optional). Follow [docs/mcp.md](docs/mcp.md).

To try your own contract, attach a text PDF or Word file (up to 15 MB and about 100 pages) to any work item and click **Extract**.

## What it reads, and what it doesn't

- Text PDFs and Word (.docx) files. Scanned PDFs need OCR, which Covenant does not do, and it says so.
- One contract per file. Amendments are not linked to the agreement they amend.
- English contracts. The evaluation below is on English commercial contracts.
- Service levels: incident counts and resolution times are measured from Jira. Anything else, such as uptime, says "cannot be measured here".
- Holiday calendars are weekends only until someone pastes the contract's holiday list into the panel.

## How well it reads contracts

**Every value Covenant gave was right: 57 of 57.** When it wasn't sure, it didn't guess. It left the value for a person, with the clause it found. A wrong deadline can cost a year's renewal; a blank one costs a reviewer a minute.

Covenant was scored against 30 contracts from CUAD (below), the expert-labelled public contract dataset, with the production model, `claude-haiku-4-5-20251001`, on 15 Nov 2026 (extractor version 2). The full report is in [eval/report.md](eval/report.md).

| What | Right when it answered | Not answered | Exact match overall |
| --- | --- | --- | --- |
| Notice period to stop a renewal | 100% (14/14) | 1 of 15 | 93.3% (14/15) |
| Renewal term | 100% (13/13) | 1 of 14 | 92.9% (13/14) |
| Effective date | 100% (15/15) | 6 of 21 | 71.4% (15/21) |
| Expiration date | 100% (15/15) | 7 of 22 | 68.2% (15/22) |
| All four | **100% (57/57)** | 15 of 72 | 79.2% (57/72) |

Of the 15 not answered, 14 were found and deliberately left for a person, and 1 was not found. Some depend on something the text doesn't say, such as an effective date set by "the last date of signature"; filling them would be guessing. Some are dates the parser refuses because their text is unclear or oddly split by the PDF, and it refuses rather than risk a wrong date. 96.4% (348/361) of the quotes the model returned were found word for word; the rest were dropped, as they are in production. The run cost about $1.39.

**Trap contracts.** Twenty short invented contracts try to break the extractor: conflicting notice periods, dates in words, two-digit years, blanks, a planted instruction to an AI, a planted fee, notice periods in business days, and more. All 20 pass ([eval/traps.md](eval/traps.md)).

**Quality gate.** `npm run traps -- --gate` fails when fewer traps pass than [eval/baseline.json](eval/baseline.json) records, and the CI workflow runs it on every push to main and every pull request whenever the repository has an Anthropic API key. `npm run eval -- --gate` does the same for the CUAD scores on a machine that has the dataset (CUAD files never go in git). To prove it, a deliberately broken prompt that tells the model to obey the contract's text let the planted fee through, and the gate failed (19 of 20). Everything else held even under that prompt, because code checks every quote and computes every date.

## How it is built

| Part | Forge module or API |
| --- | --- |
| Covenant panel on the work item | `jira:issuePanel` (UI Kit) |
| Covenant register with charts | `jira:globalPage` (UI Kit `BarChart`) |
| Admin page: preflight, one-click setup, quality, AI access log | `jira:adminPage` |
| Extraction, details pass and evidence checks (up to 15 minutes) | `consumer` with `@forge/events` queues |
| Evidence on receipt | `trigger` on `avi:jira:created:attachment` |
| Daily check and Decision due items | `scheduledTrigger` |
| Contract reading | `llm` (Forge LLMs, Claude Haiku 4.5) |
| Storage | `sql` (Forge SQL) |
| Rovo agent, skill and MCP tools | `rovo:agent`, `rovo:skill`, `action`, `rovo:mcp` |
| Related work, goals, teams, owners | Teamwork Graph API, as the signed-in user |

- `packages/core`: pure TypeScript with no Forge, Node or browser imports: the schema, extractor, details pass, evidence check, quote verifier, critic, clause locator, date engine with holiday calendars, money parser, notice and service-level calculations, and injection detector, and the panel's at-a-glance next step. 554 unit and property-based tests.
- `test/forge`: app tests with Jira, Forge SQL and Teamwork Graph faked. They prove a user who cannot see a contract gets nothing from any tool, a planted clause is not followed, every tool read is logged with ids only, and no log line can contain contract text.
- `src/forge`: resolvers, the queue worker, the daily job, the attachment trigger, the four tools, Forge SQL repositories and the Teamwork Graph client.
- `src/frontend`: the UI Kit screens.
- `eval`: scores `packages/core` against CUAD and the trap suite; see [eval/README.md](eval/README.md).
- `skills/covenant-renewal-review/SKILL.md`: the Rovo skill the agent uses. `skills/covenant-contracts/SKILL.md`: an open-source skill for outside agents using the MCP tools.

### Develop

```bash
npm install
npm run check                      # type-check everything and run all tests
npm run traps                      # the 20 trap contracts; needs ANTHROPIC_API_KEY
npm run eval -- --dev              # score 10 CUAD contracts; needs ANTHROPIC_API_KEY and eval/data/cuad
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

## What was cut

To fit the deadline, these were left out on purpose:

- Amendment precedence: an amendment is read as its own contract, not merged into the agreement it changes.
- A Teamwork Graph connector for outside contract systems.
- Assigning work items to the Covenant agent: Forge agents cannot be assigned yet ([docs/spikes.md](docs/spikes.md), S8). A Jira Automation rule runs the agent instead.
- OCR, Confluence or Jira Service Management screens, Marketplace licensing, vector search or retrieval pipelines, agent frameworks, custom JQL functions, and any call to a service outside Atlassian.

## Support and privacy

Questions, problems or data requests: [open an issue](https://github.com/Dheeru-Reddy-ui/covenant/issues). What Covenant stores and how it is removed: [PRIVACY.md](PRIVACY.md).

## Credits and licence

The evaluation uses **CUAD v1**, the Contract Understanding Atticus Dataset, by The Atticus Project, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([doi:10.5281/zenodo.4595826](https://doi.org/10.5281/zenodo.4595826)). Hendrycks, Burns, Chen and Ball, "CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review", NeurIPS 2021. No CUAD contract ships with the app or sits in this repository; the sample contracts and certificates are invented.

Covenant is released under the MIT licence; see [LICENSE](LICENSE).
