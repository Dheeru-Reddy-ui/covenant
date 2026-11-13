# Covenant

**Contract obligations as dated, owned, clause-cited Jira work items.** A Forge app for Jira, built for Atlassian Codegeist 2026 (Apps for Business Teams).

Attach a contract (a text PDF or a Word file) to a Jira work item and click **Extract**. Covenant finds the contract's obligations: renewal and termination notice deadlines, payments, price changes, reports, audit and insurance duties, and service credits. Each one comes with the verbatim clause it came from and where it sits ("clause 1.2 (Term and renewal), page 4"). A person approves, edits or rejects each one. Approving creates a child work item with the due date already set.

Before a renewal notice window closes, Covenant opens a **Decision due** work item. The renewal brief shows the deadline, the governing clause, the dates that move if the contract renews, and context from Jira and Teamwork Graph: related work, incidents, goals and suggested owners. Record the decision with a rationale, or mark the contract renewed and watch its dates move to the next term. A Rovo agent and an MCP server answer the same questions from chat, citing the clause behind every date.

## Why you can trust the dates

- **The model never computes a date.** It reads the contract and returns rules: who must act, measured from what, by how much. Tested code works out every date from those rules.
- **Every quote is checked.** A quote that does not appear word for word in the file, spacing aside, is dropped along with its obligation. Code, not the model, works out the page and clause number from where the quote sits.
- **Doubt goes to a person.** Unsure readings are read a second time; if the two readings disagree, the obligation is flagged for review rather than guessed.
- **Nothing reaches Jira without a person.** Work items are created only when someone approves, and the write tool refuses unless the person confirms.
- **Contract text never leaves Atlassian and never goes in a log.** The model is Atlassian-hosted Claude through Forge LLMs, data lives in Forge SQL, and logs hold ids, counts and timings only. The app is eligible for Runs on Atlassian.
- **Personal data is kept to account ids and reported.** Covenant reports the ids it stores each week through Atlassian's personal data reporting API, and erases a closed account's id. Names live only in a cache that expires within the hour. See [PRIVACY.md](PRIVACY.md).

## Install and try it (about 10 minutes)

You need a Jira Cloud site where you are a site admin, with at least one Jira space (project). On a brand-new site, Jira asks you to create a first space before anything else; any template works, and Covenant was tested in a Business space. Rovo is optional. Turning on the MCP tools for outside clients needs an organization admin.

1. **Install.** Open the installation link from the submission and click **Get app**. Choose your site (Covenant is added to Jira), review the permissions, and click **Install**.
2. **Check the setup.** In Jira, open **Settings** (the gear at the top right), then **Marketplace apps**. In the settings sidebar, under **Apps**, click **Covenant**. The **Preflight** section checks the database, the model, Jira, Teamwork Graph and the daily check, and says what to do about anything that is not green. The daily check shows a warning until it has run once; step 8 runs it.
3. **Load the sample workspace.** On the same page, under **Sample workspace**, pick a project you can create work items in and click **Load sample workspace**. It creates three fictional contracts as work items, each with its Word file attached, plus related tasks and an incident, and extracts them. Their notice deadlines fall about 20, 50 and 85 days from today. The page shows progress as it goes; it took about 30 seconds on a clean site. Extraction uses a few cents of model tokens, billed to the app's developer, not to you.
4. **Open a contract.** Open the work item **Contract: Quillfeather Systems route planning MSA**. If you don't see the Covenant panel, open the work item's **View app actions** menu and choose **Covenant**.
5. **Review.** Each obligation shows its clause, its rule and its due date. Click **Approve and create work item** on one, and a child work item appears with its due date set. Try **Edit** or **Reject** on another.
6. **Decide on the renewal.** In **Renewal decision**:
   - Click **Show related work, goals and suggested owners** to load context from Jira and Teamwork Graph.
   - Click **Record decision**, choose an outcome and write a rationale.
   - Click **Mark renewed** to watch the dates move to the next term. **Undo renewal** puts them back.
7. **See the portfolio.** Open **Apps** in Jira's sidebar, then **Covenant register**, for every obligation by due date with 30, 60 and 90 day views. The **Inside notice window**, **No owner** and **Overdue** flags mark what needs attention.
8. **Get the Decision due items.** Covenant's daily check opens a **Decision due** work item for each contract whose notice deadline is inside the decision window (60 days by default). It runs within a day of installing. To run it now, use **Run the daily check now** on the admin page.
9. **Ask Rovo** (if your site has Rovo: look for **Ask Rovo** in Jira's top bar). Open Rovo chat, click the agent name at the top of the chat, choose **Covenant contract assistant**, and ask *Which notice deadlines fall in the next 90 days?* New sites may not have Rovo; the demo video shows the agent.
10. **Use an outside MCP client** (optional). Follow [docs/mcp.md](docs/mcp.md): an organization admin turns on Covenant's tools, then any MCP client connects to `https://mcp.atlassian.com/forge/0eb73671-31a0-4410-ae90-4d8ba0607caa`.

To try your own contract, attach a text PDF or Word file (up to 15 MB and about 100 pages) to any work item and click **Extract** in its Covenant panel.

## What it reads, and what it doesn't

- Text PDFs and Word (.docx) files. Scanned PDFs need OCR, which Covenant does not do, and it says so.
- One contract per file. Amendments are not linked to the agreement they amend.
- English contracts. The evaluation below is on English commercial contracts.
- A contract term measured in business days is not rolled forward into the next term; Covenant says so instead of guessing.

## How well it reads contracts

Covenant was scored against 30 contracts from CUAD (below) with the production model, `claude-haiku-4-5-20251001`, on 12 Nov 2026. The full report is in [eval/report.md](eval/report.md).

| What | Exact match | Exact when it answered |
| --- | --- | --- |
| Notice period to stop a renewal | 93.3% (14/15) | 100% (14/14) |
| Renewal term | 100% (14/14) | 100% (14/14) |
| Effective date | 71.4% (15/21) | 100% (15/15) |
| Expiration date | 68.2% (15/22) | 100% (15/15) |
| All four | 80.6% (58/72) | 100% (58/58) |

The gap between the columns is deliberate: when a reading is doubtful, Covenant leaves the value for a person. 95.5% (317/332) of the quotes the model returned were found word for word in the contract; the rest were dropped, as they are in production. The run cost about $1.18 for all 30 contracts.

## How it is built

| Part | Forge module or API |
| --- | --- |
| Covenant panel on the work item | `jira:issuePanel` (UI Kit) |
| Covenant register | `jira:globalPage` |
| Admin page with preflight and the sample workspace | `jira:adminPage` |
| Extraction (up to 15 minutes) | `consumer` with `@forge/events` queues |
| Daily check and Decision due items | `scheduledTrigger` |
| Contract reading | `llm` (Forge LLMs, Claude Haiku 4.5) |
| Storage | `sql` (Forge SQL) |
| Rovo agent and MCP tools | `rovo:agent`, `action`, `rovo:mcp` |
| Related work, goals, teams, owners | Teamwork Graph API, as the signed-in user |

- `packages/core`: pure TypeScript with no Forge, Node or browser imports. It holds the schema, the extractor and its single tool, the quote verifier, the second-pass critic, the clause locator and the date engine. It has 372 unit and property-based tests.
- `test/forge`: app tests with Jira, Forge SQL and Teamwork Graph faked. They prove a user who cannot see a contract gets nothing from any tool, and that no log line can contain contract text.
- `src/forge`: resolvers, the queue worker, the daily job, the four tools, Forge SQL repositories and the Teamwork Graph client.
- `src/frontend`: the UI Kit screens.
- `eval`: scores `packages/core` against CUAD; see [eval/README.md](eval/README.md).
- `skills/covenant-contracts/SKILL.md`: an open-source skill that teaches an outside agent to use Covenant's MCP tools.

### Develop

```bash
npm install
npm run check                      # type-check everything and run all tests
npm run eval -- --dev              # score 10 CUAD contracts; needs ANTHROPIC_API_KEY and eval/data/cuad
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

## Support and privacy

Questions, problems or data requests: [open an issue](https://github.com/Dheeru-Reddy-ui/covenant/issues). What Covenant stores and how it is removed: [PRIVACY.md](PRIVACY.md).

## Credits and licence

The evaluation uses **CUAD v1**, the Contract Understanding Atticus Dataset, by The Atticus Project, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([doi:10.5281/zenodo.4595826](https://doi.org/10.5281/zenodo.4595826)). Hendrycks, Burns, Chen and Ball, "CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review", NeurIPS 2021. No CUAD contract ships with the app or sits in this repository; the sample workspace's contracts are invented.

Covenant is released under the MIT licence; see [LICENSE](LICENSE).
