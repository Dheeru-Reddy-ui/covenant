---
name: covenant-contracts
description: Answer questions about contract deadlines and obligations tracked in Jira by the Covenant app, cite the exact clause behind each date, brief a person on an upcoming renewal, and record their renewal decision. Use when the Covenant MCP server is connected and the user asks about notice deadlines, renewals, contract obligations, what is overdue, or wants to record a renew, renegotiate or terminate decision.
license: MIT
---

# Covenant: contract obligations in Jira

Covenant is a Forge app for Jira. A person attaches a contract (a text PDF or a Word file) to a Jira work item, and Covenant extracts its obligations: renewal and termination notice deadlines, payments, price changes, reports and deliverables, audit and insurance duties, and service credits. Each obligation keeps the clause it came from, quoted word for word. A person reviews each one in Jira before it becomes a work item with a due date.

This skill teaches you to work with Covenant through its MCP server. You can read obligations, show their clauses, brief a person on a renewal, and record their decision. You cannot approve, edit or reject obligations: a person does that in the Covenant panel on the contract's work item.

## How Covenant's review works

Knowing where each obligation sits lets you tell the person what is settled and what still needs a human.

1. **Extract.** On a contract's work item, someone opens the Covenant panel and clicks Extract. A language model reads the text and returns rules: who must do what, measured from which event, with the clause quoted. It never returns dates.
2. **Verify.** Code checks every quote word for word against the file and drops any it cannot find. Code then works out the page from where the quote sits.
3. **Date.** Covenant's date engine turns each rule into a due date from the contract's terms. If a rule depends on something the contract doesn't fix, such as an invoice date, the obligation has no date yet and says why.
4. **Second reading.** Clauses the model was unsure about are read again. If the two readings disagree, the obligation is `flagged`.
5. **Human review.** In the panel, a person approves, edits or rejects each obligation. Approving creates a Jira work item with the due date. A rejected obligation no longer appears in `list_obligations`. Until then it is `awaiting_review` or `flagged`.
6. **Decision window.** A daily job watches every renewal notice deadline. When one comes within the site's lead time (60 days by default), Covenant opens a "Decision due" work item, and the brief's `noticeDeadline.status` becomes `due`.
7. **Decision.** A person records renew, renegotiate or terminate with a rationale, in the panel or through `record_decision`. When a contract renews, a person marks it renewed in the panel and its dates move to the next term.

As an outside agent you work in steps 6 and 7. For anything in steps 1 to 5, send the person to the contract's work item.

## Connecting

- Endpoint: `https://mcp.atlassian.com/forge/0eb73671-31a0-4410-ae90-4d8ba0607caa` (Streamable HTTP, OAuth 2.1). The person signs in, picks their Atlassian site, and approves access.
- An organization admin must first turn on Covenant's tools for the site. `docs/mcp.md` in this repository has the steps.
- Tool names are `list_obligations`, `get_clause`, `get_renewal_brief` and `record_decision`. Outside production they carry an environment suffix, such as `list_obligations_development`. Match tools by prefix and never hard-code the suffix.
- Every tool runs as the signed-in person. It sees only contracts on Jira work items that person can see. A contract they cannot see looks exactly like one that does not exist.

## The rules that matter most

1. **Never work out a date.** Covenant's date engine computes every date from the clause and the contract terms, and it is tested. Repeat `due`, `deadline` and `daysLeft` exactly as given. Do not add days, convert time zones, or estimate a date that came back `null`.
2. **Cite every date.** When you state a deadline or an obligation, quote its clause word for word in quotation marks. Then give the `location` and the contract's work item key or link. Examples of `location`: `clause 1.2 (Term and renewal), page 4`, or `clause 1.2 (Term and renewal), Word file` for a Word file, which has no pages. Never present a paraphrase as a quote.
6. **Use the person's calendar.** Pass `timeZone` (an IANA name such as `Europe/London`) when you know it, so `today` and `daysLeft` match their date. The reply gives the `timeZone` it used; without one, it is UTC.
3. **Say what is unconfirmed.** `review` is `approved` (a person approved it), `awaiting_review` (nobody has yet) or `flagged` (the extractor was unsure or its two readings disagreed). Tell the user when an obligation is not approved. For a flagged one, point them to the work item so a person can check it.
4. **Never record a decision without explicit consent.** `record_decision` takes two calls (see below). Never set `confirm` on your own judgment, and never write the rationale for the person.
5. **Respect `null` and `ok: false`.** A null date comes with a reason (`noDateBecause` or `note`). An `ok: false` reply comes with `error` and sometimes `problems`. Pass the reason on to the user. If `problems` lists input errors, fix them and retry once.

## Tools

### list_obligations

Use it for portfolio questions: "Which notice deadlines fall in the next 90 days?", "What is overdue?", "What does Supplier X have to deliver this quarter?"

Inputs, all optional:
- `withinDays`: from 1 to 730. It returns only what falls due from today to that many days ahead. Leave it out to get everything, including overdue and undated items.
- `kind`: one or more kinds, comma separated: `renewal_notice`, `payment`, `price_change`, `reporting_deliverable`, `audit_insurance`, `service_credit`. Words such as `notice`, `insurance` or `SLA` also work. Unknown words are an error, never a guess.
- `contract`: part of the work item title, the work item key or the file name. A counterparty's name usually matches the title.
- `party`: part of the responsible party's name, such as `Customer`.
- `status`: `open` (the default, everything not rejected), `needs_review` or `approved`.
- `limit`: from 1 to 100. The default is 25. If `truncated` is true, narrow the filters.
- `timeZone`: the person's IANA time zone. The default is UTC.

Returns `{ok, today, timeZone, filters, matched, returned, truncated, decisionLeadDays, obligations[], note}`. Each obligation has:
- `obligationId`, plus `contract {workItem, title, file, contractId, url}`;
- `kind`, `kindLabel`, `summary`, `responsibleParty` and `timing` (the rule in words);
- `due` (YYYY-MM-DD or null), `daysLeft`, `dateStatus` (`upcoming`, `past` or `undated`) and `noDateBecause`;
- `review`, `insideNoticeWindow`, `overdue`, `owner`, `workItem` and `workItemUrl`;
- `citation {quote, location, clause, clauseHeading, page, pageEnd, pageUncertain}`. Code finds `clause` (such as `1.2`) and its heading from the numbering around the quote. Both are null when the contract doesn't number that passage. `page` is null for Word files.

Rows are sorted by due date, with undated rows last. Rejected obligations never appear.

### get_clause

Use it when the user wants the exact wording behind one obligation or asks where a date comes from. Input: `obligationId`, taken from `list_obligations`.

Returns:
- the obligation: `kind`, `summary`, `responsibleParty`, `timing`, `review` and `rejected`;
- `citation {quote, location, clause, clauseHeading, page, pageEnd, pageUncertain}`;
- `source {workItemUrl, file, howVerified}`.

Covenant checked the quote word for word against the file's text, and found the page from where the quote sits. If `pageUncertain` is true, the same words appear more than once in the file.

### get_renewal_brief

Use it before discussing or recording a renewal decision. Inputs:
- `contract` (required): the work item key, such as `LEGAL-12`, or a link to it.
- `contractId`: needed only if the work item holds several contracts. The error lists the ids.
- `includeContext`: true by default.
- `timeZone`: the person's IANA time zone. The default is UTC.

Returns:
- `contract`, `autoRenews` and `currentTerm {number, start, end}`;
- `noticeDeadline {status, meaning, deadline, daysLeft, decisionWindowOpens, termEnds, rule, note}`, where `status` is one of:
  - `later`: the decision window has not opened yet;
  - `due`: a decision is needed now;
  - `passed`: notice can no longer be given for this term;
  - `undated` or `no_notice_rule`: read `note`.
- `governingClauses[] {role, quote, location}`, `decisionWorkItem` and `pastDecisions[]`. Each passage is quoted once: when the notice words are part of the renewal sentence, the role is `Renewal and notice`;
- `ifMarkedRenewed {possible, nextTerm, datesThatMove[] | reason}`;
- `context {relatedWork[], goals[], teams[], suggestedOwners[] {name, score, evidence[]}, problems[]}` and `contextNote`.

Related work comes from Jira links and child items, and goals and teams from Teamwork Graph. Owner suggestions rank people by their history on that work, and each one carries its evidence. Present them as suggestions with that evidence, not as facts. If `problems` is not empty, say which part could not be loaded rather than reporting "none".

### record_decision

Use it only when the person wants to record a renewal decision. Inputs:
- `contract` and, if needed, `contractId`;
- `outcome`: `renew`, `renegotiate` or `terminate`;
- `rationale`: their reason, 10 to 4,000 characters;
- `confirm`.

It always takes two calls:

1. **Call it without `confirm`.** Nothing is written. The reply is `{ok: false, refused: "confirmation_required", wouldRecord, nextStep}`.
2. **Show the person `wouldRecord`:** the contract, outcome, rationale, term and notice deadline. Ask them to confirm.
3. **Only after they clearly say yes** to that exact outcome and rationale, call it again with the same inputs and `confirm: true`. If they change anything, go back to step 2.

A confirmed call returns `{ok: true, recorded: true, decisionId, decision, commentedOn}`. Covenant stores the decision with a snapshot of the brief, and comments on the contract's "Decision due" work item if there is one. Repeating the same confirmed call within 15 minutes returns the earlier record and does not create a duplicate.

Recording a decision does not renew or end the contract and does not contact the other party. Tell the person if they seem to expect otherwise.

## Workflows

**"Which notice deadlines fall in the next 90 days?"** Call `list_obligations` with `kind: "renewal_notice"` and `withinDays: 90`. Answer with one line per deadline, in date order: the date, the days left, the contract (title and key) and its review state. Then give each citation: the quote in quotation marks, then its location.

**"Brief me on the Acme renewal."** If you don't know the work item key, call `list_obligations` with `contract: "Acme"` and `kind: "renewal_notice"`. Then call `get_renewal_brief` with the key. Lead with the deadline and what `status` means, then the governing clause, then past decisions, related work and incidents, and the suggested owners with their evidence.

**"We'll renew Acme because usage is up."** Get the brief if you don't have it. Call `record_decision` without `confirm` and show the preview. Wait for an explicit yes, then call again with `confirm: true`. Report `decisionId` and the work item that was commented on.

**An obligation is flagged or awaiting review.** Say so plainly, give its clause, and link the contract's work item (`contract.url`). There, a person opens the Covenant panel (the work item's "View app actions" menu, then Covenant) to approve, edit or reject it.

## Limits

- Each call must finish within 55 seconds. `get_renewal_brief` with context usually takes 1 to 3 seconds.
- `list_obligations` returns at most 100 rows. Use the filters for larger portfolios.
- Covenant reads text PDFs and Word files. It does not read scanned images, and it does not track amendments.
- Covenant reports what a contract says and what it worked out from it. It does not give legal advice.
