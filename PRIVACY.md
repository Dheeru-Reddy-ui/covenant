# Covenant privacy policy

Covenant is a Forge app for Jira Cloud, built by Dheeru Reddy for Atlassian Codegeist 2026. This page explains what Covenant reads, what it stores, and how that data is removed. Covenant runs entirely on Atlassian's Forge platform. It calls no service outside Atlassian, and it is eligible for Atlassian's Runs on Atlassian programme.

Questions or deletion requests: open an issue at https://github.com/Dheeru-Reddy-ui/covenant/issues.

## What Covenant reads

- **A contract file, when a person clicks Extract.** The file stays in Jira. Covenant downloads it, reads its text in memory, and sends that text to Atlassian-hosted Claude through Forge LLMs. The model returns the contract's obligations. The full text is not stored.
- **Jira work items and Teamwork Graph data, when a person opens a renewal brief's context.** This covers linked and child work items, goals, teams and their members, and who commented on related work. Covenant reads it as that person, so it sees only what they can see.

## What Covenant stores

Covenant keeps its data in Forge SQL, Atlassian's hosted storage for the app's installation on your site:

- **From the contract:** short quotes (the clauses behind each obligation, word for word), the rules extracted from them, their due dates, the file name, and the work item it is attached to.
- **Review and decisions:** which obligations were approved, edited or rejected. A renewal decision is stored with its outcome, its rationale and a snapshot of the brief. The snapshot lists related work items, goals and teams, but no people.
- **Who did what:** the Atlassian account id of whoever extracted, approved, rejected, decided, renewed or changed a setting. Covenant does not store email addresses.
- **A short-lived context cache:** the related work, goals, teams and suggested owners a person last saw, including people's display names. This speeds up reopening a brief. It is served for one hour, and the daily check deletes expired entries.

Covenant's logs contain ids, counts and timings, never contract text.

## Personal data and Atlassian's reporting

Covenant follows Atlassian's user privacy guidelines for apps that store personal data:

- **Weekly report.** Each week, Covenant reports the account ids it stores through Atlassian's personal data reporting API.
- **Closed accounts.** When Atlassian reports an account as closed, Covenant replaces its id everywhere it is stored and deletes any cached context that names it. Decisions it made then show "a former user".
- **Changed accounts.** When Atlassian reports an account as changed, Covenant deletes any cached context that names it, so the next view fetches it fresh.

## Who can see the data

Everything respects Jira's permissions:
- The Covenant panel appears only on work items a person can open.
- The register and the Rovo and MCP tools show only contracts on work items the person can see.
- The admin page is for Jira administrators.

## Retention and deletion

Covenant keeps its data while it is installed. When an administrator uninstalls Covenant, Atlassian soft-deletes the app's stored data and permanently deletes it after its retention period. Within 21 days of uninstalling, the data can be relinked to a new installation through Atlassian support. To have data deleted while Covenant is installed, open an issue at the address above.

## Changes

Any change to this policy is recorded in this repository's history.
