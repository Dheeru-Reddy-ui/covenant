# Covenant demo video script

**Target:** 4:30, public on YouTube. The story is complete by 3:00; everything after that is for the bonus prizes.

**Rules:** the video should be under 5 minutes, and judges needn't watch past 5. It must not include third-party trademarks or copyrighted music without permission. Record with no music, or with music you made or have a licence for. Crop or blur any browser logos, tab favicons and MCP-client branding.

**Set-up before recording:**
- Load a fresh sample workspace, so the notice deadlines sit about 20, 50 and 85 days out.
- Run the daily check, so the Decision due items exist.
- Leave one obligation unapproved to demonstrate.
- Use a 1080p window at 125% zoom.

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0:00 | A contract work item in Jira, the Word file attached | "Every contract hides deadlines: 90 days' notice before it renews, a certificate due a month after each anniversary. They live in a drive, the work lives in Jira, and the dates fall in the gap. Covenant closes it." |
| 0:15 | Covenant panel: click **Extract**, then the list appears | "Attach the contract and click Extract. Covenant reads it with Atlassian-hosted Claude and lists every obligation." |
| 0:30 | One obligation: clause quote, "clause 1.2 (Term and renewal)", rule, due date | "Each one comes with the exact clause, quoted word for word and checked against the file, and where it sits. The model never writes a date. It returns the rule, 90 days before the end of the term, and tested code works out the date." |
| 0:55 | "7 of 7 quotes found word for word"; a flagged item | "A quote that isn't in the file is dropped. A reading the model isn't sure of is read twice, and if the readings disagree, it's flagged for a person instead of guessed." |
| 1:10 | Click **Approve and create work item**; the child work item opens with its due date and the arithmetic | "Nothing reaches Jira until a person approves it. Approving creates a work item with the due date set, the clause, and how the date was worked out." |
| 1:30 | The Decision due work item, then the panel's **Renewal decision** with its countdown | "Before the notice window closes, Covenant's daily check opens a Decision due item. The brief shows the deadline, the days left and the governing clause." |
| 1:50 | **Show related work, goals and suggested owners** | "One click pulls context from Teamwork Graph and Jira: related work, the incident from last month, goals, and suggested owners, each with the evidence behind the suggestion." |
| 2:10 | **Record decision**: renew, with a rationale | "Record the decision and why. Covenant keeps a snapshot of what it was based on, and comments on the Decision due item." |
| 2:25 | **Mark renewed**: the dates move to the next term | "Mark the contract renewed and every date that hangs off the term moves on screen. That's the rule graph made visible." |
| 2:40 | Sidebar **Apps** → **Covenant register**: the 90-day view and its flags | "The register shows every obligation across every contract you can see, by due date, with what's inside a notice window or has no owner." |
| 2:55 | Back on the contract | "From contract to dated, owned, clause-cited work, with a person in charge of every step." |
| 3:05 | Rovo chat: choose **Covenant contract assistant**, ask *Which notice deadlines fall in the next 90 days?* | "The same answers in Rovo. The agent lists each deadline in date order, quotes the clause behind it, and says which ones nobody has confirmed yet." |
| 3:30 | Ask Rovo to record a renewal decision; the preview, then the confirmation | "Writes take two steps. The tool refuses until the person confirms the exact outcome and rationale." |
| 3:45 | An outside MCP client, cropped to the chat area, asking the same question | "And from outside Atlassian: an admin turns on Covenant's MCP tools, any MCP client connects, and an open-source skill file teaches it the rules: never recalculate a date, always quote the clause." |
| 4:05 | `eval/report.md`: the results table | "Measured on 30 public CUAD contracts: 93 percent of notice periods exactly right, and every value Covenant gave was correct. When it isn't sure, it leaves the value to a person." |
| 4:20 | The admin page's preflight and **Load sample workspace** | "It runs entirely on Forge, it's eligible for Runs on Atlassian, it reports the personal data it holds, and the sample workspace lets you try it in minutes." |
| 4:30 | End | (The name and the installation link on screen.) |

## Shots to capture separately

- The child work item's description: the "How the date was worked out" list.
- A Word-file citation: "clause 1.2 (Term and renewal), Word file".
- The rollover preview's leap-year shift, 2027-02-05 to 2028-02-06, if Corvane is used.

## Open question

Which MCP client to film with no visible third-party logo. The options are the Claude app or MCP Inspector, either cropped to the conversation or results area so no logo or product name shows. Check the final cut frame by frame for logos.
