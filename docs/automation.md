# Run the Covenant agent when a decision is due

Covenant's daily check opens a "Decision due" work item before a contract's renewal notice deadline. With this Jira Automation flow, the Covenant agent then writes a renewal brief on that work item straight away. Every date and quote in the brief comes from Covenant's tools.

The flow only reads and comments. The agent cannot record a decision from Automation: `record_decision` needs the person's explicit confirmation in a conversation, the agent's instructions forbid it otherwise, and with **Let this agent take actions** off (step 5) the agent can only read.

Covenant's Forge agent cannot be assigned work items yet, so Automation is how it acts on a work item (`docs/spikes.md`, S8).

## Before you start

- Rovo is on for the site, and the Covenant app is installed.
- You can create Automation flows in the space (project) where Covenant opens decision items. That is the space of the contract's work item.
- The agent step runs with the permissions of the person who connects Automation to Rovo (step 5), not the flow's actor, so that person needs to see the contracts' work items. The comment itself is posted by "Automation for Jira".

## The flow

Jira calls these "flows" now; older sites call them "rules".

1. Open the space, then **Space settings** (or **Project settings**), then **Automation**. Click **Create flow**, then **Create from scratch**.
2. **Trigger:** *Work item created*.
3. **Condition:** *Work item fields condition*. Field: **Summary**. Condition: **starts with**. Value: `Decision due`.
   Covenant names decision items "Decision due: renew, renegotiate or terminate <file> by <deadline>", and each one is a child of the contract's work item.
4. **Condition (optional):** *Work item fields condition*. Field: **Parent**. Condition: **is not empty**.
5. **Action:** under **Rovo AI**, choose **Use agent**. The first time, Jira asks you to **Connect** Atlassian Automation to Rovo; after that the step says "Logged in to Rovo as" you. Agent: **Covenant contract assistant**. Leave **Let this agent take actions** off, so the agent can only read. Prompt:

   ```
   A renewal decision is due for the contract on work item {{issue.parent.key}}.
   Call get_renewal_brief with contract {{issue.parent.key}}.
   Write a brief for the people who must decide: the notice deadline and what its status means, how notice must be given with the latest send-by date per delivery method, what the contract is worth, the supplier's record this term, and suggested owners with their evidence.
   Quote the clause behind every date, word for word, with its location.
   Name people in plain text, without links.
   Do not record a decision and do not choose an outcome. Reply with the brief only, with no question at the end.
   ```

6. **Condition:** *{{smart values}} condition*. First value: `{{agentResponse}}`. Condition: **does not equal**. Second value: leave it empty.
   If the agent calls a tool and ends without text, the response is empty ([ROVO-1148](https://jira.atlassian.com/browse/ROVO-1148)). This stops the flow from posting a blank comment.
7. **Action:** *Comment on work item*:

   ```
   Renewal brief from the Covenant agent. Dates and quotes come from Covenant's tools; check them in the Covenant panel on {{issue.parent.key}} before you decide.

   {{agentResponse}}
   ```

8. Click **Untitled flow** at the top and name it "Covenant: brief on new decision items", then click **Save and enable**.

## Try it

1. On Covenant's admin page, set the decision lead time so that a sample contract's deadline falls inside it, then click **Run the daily check now**. A "Decision due" work item opens.
2. Open the flow's **Audit log**: it shows the trigger, the agent call and the comment.
3. On the decision item, the comment carries the brief. To record the decision, open Rovo chat with the Covenant agent or use the Covenant panel on the contract's work item.

## Notes

- Smart values for agent output: `{{agentResponse}}` is Markdown, and `{{agentResponse.asObject}}` is JSON ([Automation smart values: Rovo agents](https://support.atlassian.com/cloud-automation/docs/automation-smart-values-rovo-agents/)).
- The flow needs no change to Covenant. If you rename decision items, change the condition in step 3.
- Each flow run counts against the site's Automation and Rovo usage. Covenant's own model calls are separate and billed to Covenant's developer.

## Tested

On 16 November 2026, on a development install with Rovo, following these steps (without the optional step 4): Covenant's daily check opened a Decision due item, the flow ran, and the Covenant agent called `get_renewal_brief` and posted the brief as a comment, with the deadline, its verbatim clause and location, the contract's value marked as not yet confirmed, the supplier's record and the suggested owner. The comment named the owner as raw link markup, which the "Name people in plain text" line in the prompt was added to prevent; that line has not been re-run yet.
