# Covenant demo video script

**Target:** 4:45, public on YouTube. The story is complete by 3:15; everything after that is for the bonus prizes.

**Rules:** the video should be under 5 minutes, and judges needn't watch past 5. It must not include third-party trademarks or copyrighted music without permission. Record with no music, or with music you made or have a licence for. Crop or blur any browser logos, tab favicons and MCP-client branding.

**Set-up before recording:**
- On a fresh site, click **Set up Covenant** on the admin page, so the notice deadlines sit about 20, 50 and 85 days out.
- On Quillfeather, confirm the parties and the contract value, and approve the insurance obligation.
- Run the daily check, so the Decision due items exist.
- Leave one obligation unapproved to demonstrate.
- Add the Automation rule from `docs/automation.md` if Rovo is on.
- Use a 1080p window at 125% zoom.

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0:00 | A contract work item in Jira, the Word file attached | "Every contract hides deadlines: 90 days' notice before it renews, a certificate due a month after each anniversary. They live in a drive, the work lives in Jira, and the dates fall in the gap. Covenant closes it." |
| 0:15 | Covenant panel: click **Extract**, then the list appears | "Attach the contract and click Extract. Covenant reads it with Atlassian-hosted Claude and lists every obligation." |
| 0:30 | One obligation: clause quote, "clause 1.2 (Term and renewal)", rule, due date; click **Why this date** | "Each one comes with the exact clause, quoted word for word and checked against the file. The model never writes a date: it returns the rule, and tested code works it out. Why this date shows every step, holidays included." |
| 0:55 | A flagged item; the warning on a clause that reads like an instruction to an AI | "A quote that isn't in the file is dropped. A doubtful reading is read twice and flagged if the readings disagree. And a clause that tries to give orders to an AI is flagged, never followed." |
| 1:10 | Click **Approve and create work item**; the child work item opens with its due date | "Nothing reaches Jira until a person approves it." |
| 1:20 | **Renewal decision**: the countdown, **Giving notice** with send-by dates per method | "Before the window closes, Covenant opens a Decision due item. The brief shows the deadline and, from the notices clause, the last day to send by registered post or email so it counts as received in time." |
| 1:40 | **Contract value** and **Supplier record this term**: a breach, a credit claimable by a date | "What's at stake: the value, quoted and confirmed. What the supplier delivered: the contract's own service levels, measured against their incidents in Jira. Code counts; nothing is estimated. A missed level shows the credit and the date to claim it by." |
| 2:05 | **Show related work, goals and suggested owners** | "Context from Teamwork Graph and Jira: related work, goals, teams and suggested owners, each with its evidence. Covenant's own work items never count as history." |
| 2:20 | **Record decision**: terminate, with a rationale; the "Send notice by" item with the drafted letter | "Record the decision and why. The Decision due item is resolved, and because notice must be given, Covenant opens a Send notice by item with the letter drafted for legal review." |
| 2:40 | The insurance obligation's work item: **Attach one with problems**; the fail with quotes from both documents and the chase draft | "When the supplier sends their certificate, Covenant checks it against the clause. This one names a different company, its limit is too low and it runs out too soon. Fail, with both documents quoted, and a chase message drafted." |
| 3:00 | Sidebar **Apps** → **Covenant register**: the money headline and the two charts | "The register leads with the money auto-renewing in the next 90 days, and charts every notice deadline across the portfolio." |
| 3:15 | Rovo chat: choose **Covenant contract assistant**, ask *Brief me on the Quillfeather renewal* | "The same answers in Rovo. A Rovo skill walks the agent through the review: deadline, send-by dates, value, the supplier's record, every point cited." |
| 3:40 | The Decision due item with the agent's brief as a comment (Automation) | "With one Automation rule, the agent briefs every new Decision due item on its own." |
| 3:55 | An outside MCP client, cropped to the chat area | "And from outside Atlassian: any MCP client connects, and an open-source skill file teaches it the rules: never recalculate a date, always quote the clause." |
| 4:10 | Admin page: **Quality** and **AI access log** | "Measured on 30 public CUAD contracts: 93 percent of notice periods exactly right, every value it gave correct, and twenty trap contracts passed, with CI failing the build if that slips. Every clause an AI reads is logged: who, when and how." |
| 4:35 | **Set up Covenant** | "It runs entirely on Forge, it's eligible for Runs on Atlassian, and one click sets up a site to try it." |
| 4:45 | End | (The name and the installation link on screen.) |

## Shots to capture separately

- The child work item's description: the "How the date was worked out" list.
- A Word-file citation: "clause 1.2 (Term and renewal), Word file".
- The holiday calendar editor and a business-day deadline moving past a holiday.
- The passing certificate check, for contrast with the failing one.

## Open question

Which MCP client to film with no visible third-party logo. The options are the Claude app or MCP Inspector, either cropped to the conversation or results area so no logo or product name shows. Check the final cut frame by frame for logos.
