# Run the Covenant agent when a decision is due

Covenant's daily check opens a "Decision due" work item before a contract's renewal notice deadline. With this Jira Automation rule, the Covenant agent then writes a renewal brief on that work item straight away. Every date and quote in the brief comes from Covenant's tools.

The rule only reads and comments. The agent cannot record a decision from Automation: `record_decision` needs the person's explicit confirmation in a conversation, and the agent's instructions forbid it otherwise.

Covenant's Forge agent cannot be assigned work items yet, so Automation is how it acts on a work item (`docs/spikes.md`, S8).

## Before you start

- Rovo is on for the site, and the Covenant app is installed.
- You can create Automation rules in the project where Covenant opens decision items. That is the project of the contract's work item.
- Rule actor: leave it as "Automation for Jira". Covenant's tools run as the rule's actor and only see contracts it can see, so the actor needs Browse permission on the contracts' project.

## The rule

1. Open the project, then **Project settings**, then **Automation**, and click **Create rule**.
2. **Trigger:** *Work item created*.
3. **Condition:** *Work item fields condition*. Field: **Summary**. Condition: **starts with**. Value: `Decision due`.
   Covenant names decision items "Decision due: renew, renegotiate or terminate <file> by <deadline>", and each one is a child of the contract's work item.
4. **Condition (optional):** *Work item fields condition*. Field: **Parent**. Condition: **is not empty**.
5. **Action:** *Use Rovo agent*. Agent: **Covenant contract assistant**. Prompt:

   ```
   A renewal decision is due for the contract on work item {{issue.parent.key}}.
   Call get_renewal_brief with contract {{issue.parent.key}}.
   Write a brief for the people who must decide: the notice deadline and what its status means, how notice must be given with the latest send-by date per delivery method, what the contract is worth, the supplier's record this term, and suggested owners with their evidence.
   Quote the clause behind every date, word for word, with its location.
   Do not record a decision and do not choose an outcome. Reply with the brief only, with no question at the end.
   ```

6. **Condition:** *Smart values condition*. First value: `{{agentResponse}}`. Condition: **is not empty**.
   If the agent calls a tool and ends without text, the response is empty ([ROVO-1148](https://jira.atlassian.com/browse/ROVO-1148)). This stops the rule from posting a blank comment.
7. **Action:** *Comment on work item*:

   ```
   Renewal brief from the Covenant agent. Dates and quotes come from Covenant's tools; check them in the Covenant panel on {{issue.parent.key}} before you decide.

   {{agentResponse}}
   ```

8. Name the rule "Covenant: brief on new decision items", turn it on, and click **Save**.

## Try it

1. On Covenant's admin page, set the decision lead time so that a sample contract's deadline falls inside it, then click **Run the daily check now**. A "Decision due" work item opens.
2. Open the rule's **Audit log**: it shows the trigger, the agent call and the comment.
3. On the decision item, the comment carries the brief. To record the decision, open Rovo chat with the Covenant agent or use the Covenant panel on the contract's work item.

## Notes

- Smart values for agent output: `{{agentResponse}}` is Markdown, and `{{agentResponse.asObject}}` is JSON ([Automation smart values: Rovo agents](https://support.atlassian.com/cloud-automation/docs/automation-smart-values-rovo-agents/)).
- Each rule run counts against the site's Automation and Rovo usage. Covenant's own model calls are separate and billed to Covenant's developer.
- The rule needs no change to Covenant. If you rename decision items, change the condition in step 3.
