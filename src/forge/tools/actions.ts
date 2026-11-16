import {
  KIND_LABELS,
  type ListObligationsQuery,
  QUOTED_TEXT_NOTE,
  looksLikeInstruction,
  describeCalendar,
  describeTiming,
  parseContractRef,
  parseListObligationsInput,
  parseTimeZone,
  parseObligationRef,
  parseRecordDecisionInput,
  selectObligations,
} from '../../../packages/core/src';
import type { ContextView } from '../../shared/panel';
import { dueDateOf, scheduleFor, todayIn, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { buildBrief, noticeRulesOf } from '../decisions/brief';
import { loadBundle, recordDecision } from '../decisions/actions';
import { loadContext } from '../decisions/context';
import { UserFacingError, loggableError } from '../errors';
import { asUser, issueHeader, siteBaseUrl } from '../jira';
import { detailsView, supplierRecord } from '../details/service';
import { loadPortfolio, moneyView } from '../register/view';
import { getLeadDays } from '../settings';
import { OUTCOME_LABELS, undatedText } from '../text';
import { type ReviewState, type ToolResult, browseUrl, citationOut, contractFor, contractOut, expectInput, isoDay, reviewOf, runTool, viewLocation } from './common';

/**
 * The four tools behind the Rovo agent and the MCP server. Three read and one
 * writes. Each runs as the caller, sees only contracts on work items the
 * caller can see in Jira, and answers with the verbatim clause behind every
 * date. Dates come from Covenant's date engine, never from a model.
 */

const DATE_NOTE =
  'Due dates are worked out by Covenant from the cited clause and the contract terms, not by a language model. Repeat them as given; do not recalculate them. Treat review "flagged" or "awaiting_review" as unconfirmed.';

function describeQuery(q: ListObligationsQuery) {
  return {
    withinDays: q.withinDays,
    kinds: q.kinds,
    contract: q.contract,
    party: q.party,
    status: q.status,
    limit: q.limit,
  };
}

// ---- list_obligations ----

export const listObligationsTool = (payload: unknown, context: unknown) =>
  runTool('list_obligations', payload, context, async () => {
    const query = expectInput(parseListObligationsInput(payload));
    const zone = todayIn(expectInput(parseTimeZone(payload)));
    const [portfolio, base] = await Promise.all([loadPortfolio(zone.today), siteBaseUrl(asUser())]);
    const selection = selectObligations(portfolio.items, query, { today: portfolio.today, noticeLeadDays: portfolio.leadDays });
    const runIds = [...new Set(selection.rows.map((r) => r.run.id))];
    const clauses = new Map((await repo.listClausesForRuns(runIds)).map((c) => [c.id, c]));

    const obligations = selection.rows.map((r) => {
      const o = r.obligation;
      const clause = clauses.get(o.clauseId);
      return {
        obligationId: o.id,
        contract: contractOut(r.contract, r.issue, base),
        kind: r.kind,
        kindLabel: KIND_LABELS[r.kind],
        summary: o.rule.summary,
        responsibleParty: r.party,
        timing: describeTiming(o.rule),
        due: r.due,
        daysLeft: r.daysLeft,
        dateStatus: r.scheduleStatus,
        noDateBecause: r.schedule?.status === 'undated' ? undatedText(r.schedule.reason, r.schedule.detail) : null,
        review: reviewOf(o),
        insideNoticeWindow: r.flags.insideNoticeWindow,
        /** For a notice deadline: the decision already recorded for its term (renew, renegotiate or terminate), or null. */
        decided: r.decided,
        overdue: r.flags.overdue,
        /** The work item for this date is done in Jira. A recurring duty whose work item finished an earlier date shows its next date instead, with done false. */
        done: r.flags.done,
        owner: r.owner?.displayName ?? null,
        workItem: o.workItemKey,
        workItemDone: r.workItemDone,
        workItemUrl: browseUrl(base, o.workItemKey),
        citation: clause ? citationOut(clause, r.run.paginated) : null,
      };
    });

    return {
      data: {
        today: portfolio.today,
        timeZone: zone.timeZone,
        filters: describeQuery(query),
        decisionLeadDays: portfolio.leadDays,
        /** Yearly value, confirmed by a person, of contracts that renew by themselves unless notice is given in the next 90 days. Code did the sum. */
        moneyAtStake: moneyView(portfolio),
        quotedText: QUOTED_TEXT_NOTE,
        matched: selection.total,
        returned: obligations.length,
        truncated: selection.truncated,
        obligations,
        note:
          obligations.length === 0
            ? 'Nothing matched. Either no contract you can see has obligations matching these filters, or none has been extracted yet.'
            : DATE_NOTE,
      },
      counts: { rows: obligations.length, matched: selection.total, contracts: portfolio.contractsShown },
      reads: selection.rows.map((r) => ({ obligationId: r.obligation.id, contractId: r.contract.id })),
    };
  });

// ---- get_clause ----

export const getClauseTool = (payload: unknown, context: unknown) =>
  runTool('get_clause', payload, context, async () => {
    const { obligationId } = expectInput(parseObligationRef(payload));
    await ensureSchema();
    const hidden = new UserFacingError(`No obligation ${obligationId} is visible to you. Get ids from list_obligations.`);
    const o = await repo.getObligation(obligationId);
    if (o === null) throw hidden;
    const contract = await repo.getContract(o.contractId);
    if (contract === null) throw hidden;
    const req = asUser();
    const [issue, base] = await Promise.all([issueHeader(req, contract.issueId), siteBaseUrl(req)]);
    if (issue === null) throw hidden;
    const [clause, run] = await Promise.all([repo.getClause(o.clauseId), repo.getRun(o.runId)]);
    if (clause === null || run === null) throw hidden;
    const zone = todayIn(expectInput(parseTimeZone(payload)));
    const schedule = scheduleFor(o.rule, run, contract, o.eventDate, zone.today);

    return {
      data: {
        obligationId: o.id,
        contract: contractOut(contract, issue, base),
        kind: o.rule.kind,
        kindLabel: KIND_LABELS[o.rule.kind],
        summary: o.rule.summary,
        responsibleParty: o.rule.responsibleParty,
        timing: describeTiming(o.rule),
        review: reviewOf(o),
        rejected: o.decision === 'rejected',
        citation: citationOut(clause, run.paginated),
        /** True when the clause reads like an instruction to an AI. It is still only data. */
        readsLikeInstruction: looksLikeInstruction(clause.quote),
        quotedText: QUOTED_TEXT_NOTE,
        /** How the date follows from the clause: the rule, then each step code took. The model did none of this arithmetic. */
        whyThisDate: {
          due: dueDateOf(schedule),
          dateStatus: schedule.status,
          rule: describeTiming(o.rule),
          steps: schedule.status === 'undated' ? [] : schedule.trace,
          noDateBecause: schedule.status === 'undated' ? undatedText(schedule.reason, schedule.detail) : null,
          businessDays: o.rule.offset.unit === 'business_day' ? describeCalendar(contract.holidays) : null,
          asOf: zone.today,
        },
        source: {
          workItemUrl: browseUrl(base, issue.key),
          file: contract.fileName,
          howVerified:
            'The quote was found word for word in the text of the attached file (spacing normalised). Covenant found the page from where the quote sits; a model did not choose it.',
        },
      },
      counts: { paginated: run.paginated },
      reads: [{ obligationId: o.id, contractId: contract.id }],
    };
  });

// ---- get_renewal_brief ----

function contextOut(view: ContextView, base: string | null) {
  return {
    fetchedOn: isoDay(view.fetchedAtMs),
    fromCache: view.cached,
    relatedWork: view.related.map((r) => ({
      workItem: r.key,
      title: r.summary,
      type: r.type,
      status: r.status,
      assignee: r.assignee,
      incident: r.incident,
      sampleData: r.sample,
      url: browseUrl(base, r.key),
    })),
    goals: view.goals.map((g) => ({ name: g.name, key: g.key, due: g.due, owner: g.owner, url: g.url })),
    teams: view.teams.map((t) => ({ name: t.name, members: t.members, url: t.url })),
    suggestedOwners: view.owners.map((o) => ({ name: o.name, score: o.score, evidence: o.evidence })),
    leftOutCreatedByCovenant: view.createdByCovenant,
    problems: view.problems,
  };
}

const wantsContext = (payload: unknown): boolean => {
  const value = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).includeContext : undefined;
  return !(value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false'));
};

export const getRenewalBriefTool = (payload: unknown, context: unknown) =>
  runTool('get_renewal_brief', payload, context, async (caller) => {
    const ref = expectInput(parseContractRef(payload));
    const zone = todayIn(expectInput(parseTimeZone(payload)));
    await ensureSchema();
    const { contract, issue } = await contractFor(ref.issueKey, ref.contractId);
    const [bundle, leadDays, base] = await Promise.all([loadBundle(issue.id, contract.id), getLeadDays(), siteBaseUrl(asUser())]);
    const today = zone.today;
    const brief = buildBrief({ ...bundle, today, leadDays });

    let related: ReturnType<typeof contextOut> | null = null;
    let contextNote: string | null = null;
    if (!wantsContext(payload)) {
      contextNote = 'Not requested.';
    } else if (caller.cloudId === null) {
      contextNote = 'Related work, goals and owner suggestions are unavailable here because the site id was not provided.';
    } else {
      try {
        related = contextOut(await loadContext(issue.id, contract.id, caller.accountId, caller.cloudId, false), base);
      } catch (error) {
        console.error(`tool get_renewal_brief context failed error=${loggableError(error)}`);
        contextNote = 'Related work, goals and owner suggestions could not be loaded this time.';
      }
    }

    // The second reading: how to give notice, what the contract is worth, and the supplier's record against its own service levels.
    const details = await detailsView(bundle, brief);
    const usable = <T extends { decision: string }>(items: T[]): T[] => items.filter((i) => i.decision !== 'rejected');
    const cited = (c: { quote: string }, clause: Parameters<typeof viewLocation>[0]) => ({ quote: c.quote, location: viewLocation(clause) });
    let supplier: Awaited<ReturnType<typeof supplierRecord>> | null = null;
    if (wantsContext(payload) && details.serviceLevels.length > 0) {
      try {
        supplier = await supplierRecord(bundle, brief, today, issue.summary || issue.key);
      } catch (error) {
        console.error(`tool get_renewal_brief supplier record failed error=${loggableError(error)}`);
      }
    }

    const w = brief.window;
    const meaning: Record<typeof w.status, string> = {
      later: `The notice deadline is more than ${brief.leadDays} days away, so no decision is due yet.`,
      due: `A decision is needed now: the notice deadline is within ${brief.leadDays} days.`,
      passed: 'The notice deadline for this term has passed, so notice can no longer be given for it.',
      undated: 'Covenant has the notice rule but cannot date it yet; see note.',
      no_notice_rule: 'Covenant has no confirmed notice rule for this contract; see note.',
    };
    return {
      data: {
        today,
        timeZone: zone.timeZone,
        contract: contractOut(contract, issue, base),
        autoRenews: brief.autoRenew,
        currentTerm: { number: brief.termNumber, start: brief.currentTerm?.start ?? null, end: brief.currentTerm?.end ?? null },
        noticeDeadline: {
          status: w.status,
          meaning: brief.decided && w.status === 'due' ? `A decision is recorded for this term (${brief.decided.outcome}). ${brief.decided.next}` : meaning[w.status],
          deadline: w.deadline,
          daysLeft: w.daysLeft,
          decisionWindowOpens: w.decisionOpensOn,
          termEnds: w.termEnd,
          rule: w.timing,
          note: w.note,
        },
        /** The decision recorded for the term this deadline belongs to, or null while one is still needed. */
        decision: brief.decided
          ? { outcome: brief.decided.outcome, decidedOn: isoDay(brief.decided.decidedAtMs), followUp: brief.decided.followUp, next: brief.decided.next }
          : null,
        decisionLeadDays: brief.leadDays,
        governingClauses: brief.clauses.map((g) => ({
          role: g.label,
          quote: g.clause.quote,
          location: viewLocation(g.clause),
          pageUncertain: g.clause.ambiguous,
        })),
        decisionWorkItem: brief.decisionItemKey ? { workItem: brief.decisionItemKey, url: browseUrl(base, brief.decisionItemKey) } : null,
        pastDecisions: brief.decisions.map((d) => ({ outcome: d.outcome, rationale: d.rationale, term: d.termNumber, decidedOn: isoDay(d.decidedAtMs) })),
        ifMarkedRenewed:
          brief.rolloverBlocked !== null
            ? { possible: false, reason: brief.rolloverBlocked }
            : { possible: true, nextTerm: brief.nextTerm, datesThatMove: brief.shifts.map((s) => ({ obligation: s.label, from: s.before, to: s.after })) },
        /** How notice must be given. sendBy is the latest day to send by that method so it counts as received by the deadline; code worked it out. */
        givingNotice: {
          mustBeReceivedBy: w.deadline,
          methods: usable(details.methods).map((m) => ({ method: m.label, sendBy: m.latest, receiptRule: m.rule, working: m.steps, ...cited(m.clause, m.clause), unconfirmed: m.needsReview })),
          addresses: usable(details.addresses).map((a) => ({ party: a.party, ...cited(a.clause, a.clause), unconfirmed: a.needsReview })),
          note:
            details.status !== 'done'
              ? 'The notices clause has not been read for this contract yet. Open the Covenant panel on the work item to read it.'
              : usable(details.methods).length === 0 && usable(details.addresses).length === 0
                ? 'Covenant found no notices clause in this contract, so only the deadline is known.'
                : null,
          noticeWorkItem: details.noticeItemKey ? { workItem: details.noticeItemKey, url: browseUrl(base, details.noticeItemKey) } : null,
        },
        /** The contract's price. Only a value a person confirmed is used in sums. */
        value: usable(details.values).map((v) => ({
          amount: v.amount,
          each: v.period,
          yearly: v.yearly,
          description: v.description,
          confirmedByAPerson: v.decision === 'confirmed',
          ...cited(v.clause, v.clause),
        })),
        /** The supplier's record this term against the contract's own service levels. Code counted Jira incidents; nothing is estimated. */
        supplierRecordThisTerm:
          supplier === null
            ? null
            : {
                filter: supplier.jql,
                incidents: supplier.incidents,
                term: supplier.term,
                serviceLevels: supplier.records.map((r) => ({
                  commitment: r.summary,
                  location: r.where,
                  status: r.status,
                  observed: r.observed,
                  breaches: r.breaches.map((b) => ({ detail: b.detail, workItems: b.workItems, claimBy: b.claimBy, claimWindowOpen: b.claimOpen, claimWorkItem: b.claimItemKey })),
                  serviceCredit: r.credit,
                  creditNote: r.creditNote,
                })),
                renegotiationSummary: supplier.leverage,
                problems: supplier.problems,
              },
        context: related,
        contextNote,
        quotedText: QUOTED_TEXT_NOTE,
        note: DATE_NOTE,
      },
      counts: { window: w.status, clauses: brief.clauses.length, context: related !== null },
      reads: [{ obligationId: null, contractId: contract.id }],
    };
  });

// ---- record_decision ----

const REPEAT_WINDOW_MS = 15 * 60 * 1000;

export const recordDecisionTool = (payload: unknown, context: unknown) =>
  runTool('record_decision', payload, context, async (caller): Promise<ToolResult> => {
    const request = expectInput(parseRecordDecisionInput(payload));
    await ensureSchema();
    const { contract, issue } = await contractFor(request.issueKey, request.contractId);
    const [bundle, leadDays, base] = await Promise.all([loadBundle(issue.id, contract.id), getLeadDays(), siteBaseUrl(asUser())]);
    const brief = buildBrief({ ...bundle, today: todayUtc(), leadDays });
    // Whether a person has confirmed the notice deadline the decision is taken against: the obligations that date it.
    const dating = new Set(noticeRulesOf(bundle.obligations).map((r) => r.id));
    const reviews = bundle.obligations.filter((o) => dating.has(o.id)).map(reviewOf);
    const noticeDeadlineReview: ReviewState | null =
      reviews.length === 0 ? null : reviews.every((r) => r === 'approved') ? 'approved' : reviews.includes('flagged') ? 'flagged' : 'awaiting_review';
    const decision = {
      contract: contractOut(contract, issue, base),
      outcome: request.outcome,
      outcomeLabel: OUTCOME_LABELS[request.outcome] ?? request.outcome,
      rationale: request.rationale,
      term: brief.termNumber,
      noticeDeadline: brief.window.deadline,
      noticeDeadlineReview,
      commentGoesOn: brief.decisionItemKey,
    };
    // A decision is never recorded against a date no person has checked: the panel shows the clause next to the date, chat may not.
    const unreviewed =
      brief.window.deadline !== null && noticeDeadlineReview !== 'approved'
        ? `the notice deadline ${brief.window.deadline} has not been confirmed by a person (review: ${noticeDeadlineReview ?? 'none'}). ` +
          `Approve the renewal notice obligation in the Covenant panel on ${issue.key} first, after checking its date against the quoted clause, then try again.`
        : null;

    if (!request.confirmed) {
      // A refusal: nothing was written, and the caller is told exactly how to proceed.
      return {
        data: {
          ok: false,
          error: 'Not recorded: confirm was not set to true.',
          recorded: false,
          refused: 'confirmation_required',
          wouldRecord: decision,
          nextStep:
            unreviewed === null
              ? 'Nothing was recorded. Show the person this outcome and rationale and ask them to confirm. Only after they clearly say yes, call record_decision again with the same inputs and confirm set to true.'
              : `Nothing was recorded, and it cannot be yet: ${unreviewed} Tell the person this; do not call record_decision with confirm until it is done.`,
        },
        counts: { recorded: false },
      };
    }

    if (unreviewed !== null) {
      return {
        data: {
          ok: false,
          error: `Not recorded: ${unreviewed}`,
          recorded: false,
          refused: 'deadline_unreviewed',
          noticeDeadline: brief.window.deadline,
          noticeDeadlineReview,
          nextStep: 'Nothing was recorded. Tell the person the notice deadline must be reviewed in the Covenant panel before a decision can be recorded against it.',
        },
        counts: { recorded: false, unreviewed: true },
      };
    }

    // A retried call should not record the same decision twice.
    const repeat = bundle.decisions.find(
      (d) =>
        d.decidedBy === caller.accountId &&
        d.outcome === request.outcome &&
        (d.rationale ?? '') === request.rationale &&
        d.termIndex === contract.termIndex &&
        Date.now() - d.decidedAtMs < REPEAT_WINDOW_MS,
    );
    if (repeat) {
      return {
        data: { recorded: true, alreadyRecorded: true, decisionId: repeat.id, decision, decidedOn: isoDay(repeat.decidedAtMs) },
        counts: { recorded: true, repeat: true },
      };
    }

    const result = await recordDecision(issue.id, contract.id, { outcome: request.outcome, rationale: request.rationale }, caller.accountId);
    return {
      data: {
        recorded: true,
        decisionId: result.id,
        decision,
        commentedOn: result.commentedOn ? { workItem: result.commentedOn, url: browseUrl(base, result.commentedOn) } : null,
        decisionItemResolved: result.resolved ? { workItem: result.resolved.key, status: result.resolved.status } : null,
        /** When the decision means notice must be given: the work item holding the drafted letter, labelled a draft for legal review. */
        noticeWorkItem: result.noticeItem ? { workItem: result.noticeItem.key, url: browseUrl(base, result.noticeItem.key), created: result.noticeItem.created } : null,
        noticeNote: result.noticeNote,
        note: result.commentedOn
          ? 'The decision, its rationale and a snapshot of the brief are stored in Covenant, and a comment was added to the decision work item.'
          : 'The decision, its rationale and a snapshot of the brief are stored in Covenant. There was no decision work item to comment on, or the comment could not be added.',
      },
      counts: { recorded: true, commented: result.commentedOn !== null },
    };
  });
