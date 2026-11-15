# Covenant privacy policy

Covenant is a Forge app for Jira Cloud, built by Dheeru Reddy for Atlassian Codegeist 2026. This page explains what Covenant reads, what it stores, and how that data is removed. Covenant runs entirely on Atlassian's Forge platform. It calls no service outside Atlassian, and it is eligible for Atlassian's Runs on Atlassian programme.

Questions or deletion requests: open an issue at https://github.com/Dheeru-Reddy-ui/covenant/issues.

## What Covenant reads

- **A contract file, when a person clicks Extract.** The file stays in Jira. Covenant downloads it, reads its text in memory, and sends that text to Atlassian-hosted Claude through Forge LLMs. The model returns the contract's obligations, then in a second reading its parties, notice address and methods, value and service levels. The full text is not stored.
- **A certificate or report attached to an obligation's work item.** When a file arrives on a work item Covenant created for an approved obligation that expects a document (such as an insurance certificate), or when a person clicks Check, Covenant reads it in memory and sends its text, with the obligation's clause, to the same model. The file stays in Jira.
- **Incidents for a contract's supplier, when a person opens the supplier record.** Covenant runs the contract's JQL filter as that person and reads each matching work item's created and resolved dates.
- **Jira work items and Teamwork Graph data, when a person opens a renewal brief's context.** This covers linked and child work items, goals, teams and their members, and who commented on related work. Covenant reads it as that person, so it sees only what they can see.

## What Covenant stores

Covenant keeps its data in Forge SQL, Atlassian's hosted storage for the app's installation on your site:

- **From the contract:** short quotes (the clauses behind each obligation, notice address, value and service level, word for word), the rules and amounts extracted from them, their due dates, the file name, and the work item it is attached to. A contract's settings: its holiday calendar, which party is yours, and its supplier filter.
- **Evidence checks:** for each checked certificate or report, its file name, the verdict, the findings with short quotes from the clause and from the document, and the drafted chase message.
- **The AI access log:** for each clause read through the panel, the Rovo agent or MCP, the reader's account id, the time, the channel and the obligation's id. Never the clause text. Repeat reads by the same person within ten minutes count once, and entries are deleted after 180 days.
- **Review and decisions:** which obligations were approved, edited or rejected. A renewal decision is stored with its outcome, its rationale and a snapshot of the brief. The snapshot lists related work items, goals and teams, but no people.
- **Who did what:** the Atlassian account id of whoever extracted, approved, rejected, decided, renewed, changed a setting, confirmed a detail, requested an evidence check or posted a chase draft. Covenant does not store email addresses.
- **A short-lived context cache:** the related work, goals, teams and suggested owners a person last saw, including people's display names. This speeds up reopening a brief. It is served for one hour, and the daily check deletes expired entries.

Covenant's logs contain ids, counts and timings, never contract text.

## Personal data and Atlassian's reporting

Covenant follows Atlassian's user privacy guidelines for apps that store personal data:

- **Weekly report.** Each week, Covenant reports the account ids it stores through Atlassian's personal data reporting API.
- **Closed accounts.** When Atlassian reports an account as closed, Covenant replaces its id everywhere it is stored, deletes its entries in the AI access log, and deletes any cached context that names it. Decisions it made then show "a former user".
- **Changed accounts.** When Atlassian reports an account as changed, Covenant deletes any cached context that names it, so the next view fetches it fresh.

## Who can see the data

Everything respects Jira's permissions:
- The Covenant panel appears only on work items a person can open.
- The register and the Rovo and MCP tools show only contracts on work items the person can see.
- The admin page, including the AI access log, is for Jira administrators.

## Retention and deletion

Covenant keeps its data while it is installed. When an administrator uninstalls Covenant, Atlassian soft-deletes the app's stored data and permanently deletes it after its retention period. Within 21 days of uninstalling, the data can be relinked to a new installation through Atlassian support. To have data deleted while Covenant is installed, open an issue at the address above.

## Changes

Any change to this policy is recorded in this repository's history.
