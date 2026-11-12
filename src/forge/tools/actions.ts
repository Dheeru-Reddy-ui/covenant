import {
  KIND_LABELS,
  type ListObligationsQuery,
  describeTiming,
  parseContractRef,
  parseListObligationsInput,
  parseTimeZone,
  parseObligationRef,
  parseRecordDecisionInput,
  selectObligations,
} from '../../../packages/core/src';
import type { ContextView } from '../../shared/panel';
import { todayIn, todayUtc } from '../dates';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { buildBrief } from '../decisions/brief';
import { loadBundle, recordDecision } from '../decisions/actions';
import { loadContext } from '../decisions/context';
import { UserFacingError, loggableError } from '../errors';
import { asUser, issueHeader, siteBaseUrl } from '../jira';
import { loadPortfolio } from '../register/view';
import { getLeadDays } from '../settings';
import { OUTCOME_LABELS, undatedText } from '../text';
import { type ToolResult, browseUrl, citationOut, contractFor, contractOut, expectInput, isoDay, reviewOf, runTool, viewLocation } from './common';

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
        overdue: r.flags.overdue,
        owner: r.owner?.displayName ?? null,
        workItem: o.workItemKey,
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
        source: {
          workItemUrl: browseUrl(base, issue.key),
          file: contract.fileName,
          howVerified:
            'The quote was found word for word in the text of the attached file (spacing normalised). Covenant found the page from where the quote sits; a model did not choose it.',
        },
      },
      counts: { paginated: run.paginated },
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
      createdByCovenant: r.viaCovenant,
      url: browseUrl(base, r.key),
    })),
    goals: view.goals.map((g) => ({ name: g.name, key: g.key, due: g.due, owner: g.owner, url: g.url })),
    teams: view.teams.map((t) => ({ name: t.name, members: t.members, url: t.url })),
    suggestedOwners: view.owners.map((o) => ({ name: o.name, score: o.score, evidence: o.evidence })),
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
          meaning: meaning[w.status],
          deadline: w.deadline,
          daysLeft: w.daysLeft,
          decisionWindowOpens: w.decisionOpensOn,
          termEnds: w.termEnd,
          rule: w.timing,
          note: w.note,
        },
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
        context: related,
        contextNote,
        note: DATE_NOTE,
      },
      counts: { window: w.status, clauses: brief.clauses.length, context: related !== null },
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
    const decision = {
      contract: contractOut(contract, issue, base),
      outcome: request.outcome,
      outcomeLabel: OUTCOME_LABELS[request.outcome] ?? request.outcome,
      rationale: request.rationale,
      term: brief.termNumber,
      noticeDeadline: brief.window.deadline,
      commentGoesOn: brief.decisionItemKey,
    };

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
            'Nothing was recorded. Show the person this outcome and rationale and ask them to confirm. Only after they clearly say yes, call record_decision again with the same inputs and confirm set to true.',
        },
        counts: { recorded: false },
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
        note: result.commentedOn
          ? 'The decision, its rationale and a snapshot of the brief are stored in Covenant, and a comment was added to the decision work item.'
          : 'The decision, its rationale and a snapshot of the brief are stored in Covenant. There was no decision work item to comment on, or the comment could not be added.',
      },
      counts: { recorded: true, commented: result.commentedOn !== null },
    };
  });
