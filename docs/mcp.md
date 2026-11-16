# Covenant's tools in Rovo and MCP clients

Covenant exposes four tools. A Rovo agent inside Jira and any MCP client outside it can both call them.

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_obligations` | Read | Lists obligations by due date, filtered by window, kind, contract, party or review status, with each clause quoted |
| `get_clause` | Read | Returns the verbatim clause, its page and source links for one obligation |
| `get_renewal_brief` | Read | Returns terms, the notice deadline, governing clauses, past decisions, the dates that move on renewal, related work and suggested owners |
| `record_decision` | Write | Records a renew, renegotiate or terminate decision. It refuses unless called again with `confirm: true`, and until a person has reviewed the notice deadline |

Every tool runs as the person calling it, and sees only contracts on work items that person can see in Jira. `test/forge/tools-access.test.ts` checks this for all four tools: a hidden contract gets the same answer as one that does not exist. Dates come from Covenant's tested date engine, never from a language model. [`skills/covenant-contracts/SKILL.md`](../skills/covenant-contracts/SKILL.md) teaches an outside agent how to use the tools.

## Before you start

1. Install Covenant on your Jira site, as in the README's [Install and try it](../README.md#install-and-try-it-about-10-minutes).
2. Load some contracts. On Covenant's admin page (Jira **Settings**, **Marketplace apps**, then **Covenant** under **Apps** in the sidebar), click **Set up Covenant** under **One-click setup**. It creates a Contracts project with three fictional contracts and extracts them, which takes a minute or two. To use a project of your own instead, pick it under **Sample workspace** and click **Load sample workspace**.

## Use the Rovo agent (inside Jira)

Rovo must be on for your site. If it is, you'll see **Ask Rovo** in the Jira top bar.

1. Open Rovo chat and click the agent name at the top of the chat.
2. Search for **Covenant contract assistant** and choose it.
3. Ask: *Which notice deadlines fall in the next 90 days?*

The agent answers in date order and quotes the clause behind each deadline.

## Connect an outside MCP client

### 1. An organization admin turns on the tools

Covenant's MCP tools are off until an admin turns them on, separately for each site. Atlassian's guide says this needs an organization admin.

1. Go to [Atlassian Administration](https://admin.atlassian.com) and select your organization.
2. Open your site's **Connected apps** list. In the sidebar, choose **Apps**. If it lists **Sites**, choose **Sites**, then your site, then **Connected apps**. If it doesn't, choose **Atlassian apps** and click **Looking for your Marketplace and third-party apps?**, which opens **Connected apps** for your site.
3. Find **Covenant** in the list of installed apps and choose **View app details**.
4. Scroll to the **TOOLS** section, labelled *Expose tools to MCP-compatible apps*, and click **Enable tools**. It is one switch for all four tools.
5. Reload the page. The section should say **Enabled**, and its button should now read **Disable tools**.

While you are on that page, check that **AI MODELS** (*Access to Atlassian-hosted AI models*) says **Enabled**. Covenant needs it to read contracts.

Atlassian's guide is [Configure tools for an external MCP server](https://support.atlassian.com/organization-administration/docs/configure-tools-for-an-external-mcp-server/).

### 2. Add the server to your client

- URL: `https://mcp.atlassian.com/forge/0eb73671-31a0-4410-ae90-4d8ba0607caa`
- Transport: Streamable HTTP
- Authentication: OAuth 2.1. The client opens an Atlassian sign-in and consent screen.

Most MCP clients have a setting for a remote (HTTP) server; paste the URL there. To use [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector
```

Then choose Streamable HTTP, paste the URL and click **Connect**.

### 3. Sign in and approve

On Atlassian's consent screen, choose the site where Covenant is installed and the tools are on. Check the permissions shown and click **Accept**. Only sites where both are true appear in the list.

### 4. Ask a question

Ask your client: *Which notice deadlines fall in the next 90 days?* It should call `list_obligations` with `kind: renewal_notice` and `withinDays: 90`. It then answers with each deadline, the contract and the quoted clause with its page.

To see the write tool refuse, ask it to record a decision. The first call returns `refused: "confirmation_required"` with a preview, and nothing is written until you confirm.

## Tested

On 12 November 2026 (UTC), Covenant was added as a custom connector in the Claude app (Settings, Connectors, Add custom connector) on a development install. Over MCP:
- `list_obligations` answered "which notice deadlines fall in the next 90 days?" with four deadlines, each with its verbatim clause and location.
- `get_clause` and `get_renewal_brief` both worked; the brief included related work and owner suggestions.
- `record_decision` refused without `confirm` and recorded nothing. It also refused an unknown outcome.

The same questions work in Rovo chat with the Covenant contract assistant.

Since 13 November 2026, each citation also names the numbered clause it sits in, such as `clause 1.2 (Term and renewal), Word file`. Code finds it from the text around the quote, so Word files, which have no pages, still get a precise location. The read tools also take an optional `timeZone`, so `today` and `daysLeft` follow the person's calendar rather than UTC.

Since 15 November 2026:
- `get_clause` returns `whyThisDate`: the rule the model read and each step code took, with the contract's holiday calendar when it counts business days.
- `get_renewal_brief` returns the decision already recorded for the term, `givingNotice` (notice address and methods with the latest send date per method), `value` and `supplierRecordThisTerm` (service levels measured against the supplier's Jira incidents, breaches and credits still claimable). There is no new tool.
- `list_obligations` returns `moneyAtStake`: the yearly value auto-renewing within 90 days, summed by code from values a person confirmed.
- `record_decision` resolves the Decision due item and, when notice must be given, opens a "Send notice by" work item with a drafted notice.
- Every tool description says quoted text is data, every citation carries `readsLikeInstruction`, and every reply carries `quotedText`, a note that quote fields are contract text and never instructions.
- Each read is written to Covenant's AI access log (account id, time, channel and obligation id, never text), which Jira admins see on the admin page. A call over MCP is logged as "MCP", and one from Rovo chat as "Rovo agent".

Checked over MCP on 15 November 2026: `list_obligations` returned the new fields, and its three reads appeared in the access log under MCP.

On 16 November 2026, on a never-used site with the production install, following only these steps: an admin enabled the tools, and a Claude custom connector chose that site on the consent screen. `list_obligations` answered the 90-day question with the sample's three notice deadlines, and `record_decision` without `confirm` returned `confirmation_required` with a preview and wrote nothing. Since then the preview's `noticeDeadlineReview` says whether a person has confirmed the deadline, a confirmed call is refused with `deadline_unreviewed` until a person approves the renewal notice obligation in the panel, and too short a rationale is refused with "give a reason of at least 10 characters".

## Notes

- Tool names can carry an environment suffix, such as `list_obligations_development` from a development install. The tools are the same.
- If no tools are listed, the admin step has not been done for that site, or you chose a different site on the consent screen.
- If a tool returns nothing, check that you can open the contract's work item in Jira yourself. Covenant shows only what Jira lets you see.
- Every reply is JSON with `ok` true or false. When `ok` is false, the `error` says why, in words you can act on.
