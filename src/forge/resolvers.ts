import Resolver from '@forge/resolver';
import { z } from 'zod';
import { AnchorEventSchema, DECISION_OUTCOMES, ObligationKindSchema, OffsetSchema } from '../../packages/core/src';
import type { Reply } from '../shared/panel';
import { runPreflight } from './admin/preflight';
import { startSampleWorkspace } from './admin/sample';
import { oneClickSetup } from './admin/setup';
import { loadAdmin, requireAdmin } from './admin/view';
import { loadBundle, markRenewed, moveWorkItemDates, recordDecision, setCalendar, undoRenewal } from './decisions/actions';
import { buildBrief } from './decisions/brief';
import { decideDetail, noticeDraft, openClaimItem, setOurParty, setSupplierJql, supplierRecord } from './details/service';
import { queueDetails } from './pipeline/details';
import { todayIn } from './dates';
import { loadContext } from './decisions/context';
import { logReads } from './access';
import { UserFacingError, loggableError, readableError } from './errors';
import { asUser } from './jira';
import { attachSampleCertificate, postChase, startEvidenceCheck } from './pipeline/evidence';
import { runDailyCheck } from './jobs/daily';
import { loadPanel } from './panel/view';
import { startExtraction } from './pipeline/start';
import { loadRegister } from './register/view';
import { approveObligation, editObligation, editTerms, rejectObligation, reopenObligation } from './review/actions';
import { getLeadDays, setLeadDays } from './settings';

/**
 * Resolvers for the issue panel, the register page and the admin page. Panel
 * resolvers read the work item from the panel's context, never from the
 * payload. Every reply is { ok, data } or { ok: false, error } in words a
 * person can act on.
 */

interface UiContext {
  accountId?: string;
  extension?: { issue?: { id?: string | number; key?: string } };
}

interface Caller {
  issueId: string;
  accountId: string;
}

function accountOf(context: unknown): string {
  const accountId = (context as UiContext).accountId;
  if (accountId === undefined) throw new Error('the request has no signed-in user');
  return accountId;
}

function callerOf(context: unknown): Caller {
  const issueId = (context as UiContext).extension?.issue?.id;
  if (issueId === undefined) throw new Error('the panel context has no work item');
  return { issueId: String(issueId), accountId: accountOf(context) };
}

async function answer<T>(name: string, run: () => Promise<T>): Promise<Reply<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    console.error(`resolver ${name} failed error=${loggableError(error)}`);
    return { ok: false, error: readableError(error, 'Something went wrong. Reload the page and try again.') };
  }
}

const Id = z.string().min(1).max(64);
const ObligationPayload = z.object({ obligationId: Id });
const ExtractPayload = z.object({ attachmentId: Id });
const CheckPayload = z.object({ checkId: Id });
const SampleCertificatePayload = z.object({ variant: z.enum(['valid', 'problems']) });
const EditPayload = z.object({
  obligationId: Id,
  edit: z
    .object({
      kind: ObligationKindSchema.optional(),
      responsibleParty: z.string().max(120).optional(),
      summary: z.string().max(300).optional(),
      anchor: AnchorEventSchema.optional(),
      anchorDescription: z.string().max(200).nullable().optional(),
      offset: OffsetSchema.optional(),
      eventDate: z.string().max(10).nullable().optional(),
    })
    .strict(),
});
const TermsPayload = z.object({ runId: Id, terms: z.unknown(), autoRenew: z.boolean() });
const DecisionPayload = z.object({ contractId: Id, outcome: z.enum(DECISION_OUTCOMES), rationale: z.string().max(4000) });
const RenewPayload = z.object({ contractId: Id, fromTermIndex: z.number().int().min(0).max(1000) });
const ContractPayload = z.object({ contractId: Id });
const DetailDecisionPayload = z.object({ contractId: Id, detailId: Id, decision: z.enum(['pending', 'confirmed', 'rejected']) });
const PartyPayload = z.object({ contractId: Id, label: z.string().min(1).max(120).nullable() });
const FilterPayload = z.object({ contractId: Id, jql: z.string().max(2000) });
const TimeZone = z.string().max(64).optional();
const DraftPayload = z.object({ contractId: Id, kind: z.enum(['non_renewal', 'renewal']), timeZone: TimeZone });
const ViewerContractPayload = z.object({ contractId: Id, timeZone: TimeZone });
const ClaimPayload = z.object({ contractId: Id, detailId: Id, breachKey: z.string().min(1).max(40), timeZone: TimeZone });
const CalendarPayload = z.object({ contractId: Id, name: z.string().max(200), text: z.string().max(20_000) });
const ContextPayload = z.object({ contractId: Id, refresh: z.boolean() });
const RegisterPayload = z.object({ windowDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.null()]), timeZone: z.string().max(64).optional() });
const LeadDaysPayload = z.object({ days: z.number().int() });
const SamplePayload = z.object({ projectId: Id, again: z.boolean() });

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error('the request was malformed');
  return result.data;
}

const resolver = new Resolver();

// ---- issue panel: extraction and review ----

// The browser sends its time zone so dates and countdowns follow the viewer's calendar. A bad zone just means UTC.
const ViewerPayload = z.object({ timeZone: z.string().max(64).optional() }).optional();

resolver.define('panel.load', ({ payload, context }) =>
  answer('panel.load', async () => {
    const caller = callerOf(context);
    const view = await loadPanel(caller.issueId, todayIn(parse(ViewerPayload, payload)?.timeZone).today);
    // The access log: every clause the panel showed this person. Repeats within ten minutes, such as polling, are ignored.
    await logReads(caller.accountId, 'panel', 'panel_view', [
      ...view.contracts.flatMap((c) => (c.run?.obligations ?? []).map((o) => ({ obligationId: o.id, contractId: c.id }))),
      ...(view.evidence ? [{ obligationId: view.evidence.obligationId, contractId: view.evidence.contractId }] : []),
    ]);
    return view;
  }),
);

resolver.define('evidence.check', ({ payload, context }) =>
  answer('evidence.check', async () => {
    const caller = callerOf(context);
    const result = await startEvidenceCheck(caller.issueId, parse(ExtractPayload, payload).attachmentId, { accountId: caller.accountId, source: 'panel', requester: asUser() });
    if (result.status === 'not_an_obligation') throw new UserFacingError('This work item is not one Covenant created for an approved obligation.');
    return result;
  }),
);

resolver.define('evidence.attachSample', ({ payload, context }) =>
  answer('evidence.attachSample', () => {
    const caller = callerOf(context);
    return attachSampleCertificate(caller.issueId, parse(SampleCertificatePayload, payload).variant, caller.accountId);
  }),
);

resolver.define('evidence.postChase', ({ payload, context }) =>
  answer('evidence.postChase', () => {
    const caller = callerOf(context);
    return postChase(caller.issueId, parse(CheckPayload, payload).checkId, caller.accountId);
  }),
);

resolver.define('extract.start', ({ payload, context }) =>
  answer('extract.start', () => {
    const caller = callerOf(context);
    return startExtraction(caller.issueId, parse(ExtractPayload, payload).attachmentId, caller.accountId);
  }),
);

resolver.define('obligation.approve', ({ payload, context }) =>
  answer('obligation.approve', () => {
    const caller = callerOf(context);
    return approveObligation(caller.issueId, parse(ObligationPayload, payload).obligationId, caller.accountId);
  }),
);

resolver.define('obligation.reject', ({ payload, context }) =>
  answer('obligation.reject', async () => {
    const caller = callerOf(context);
    await rejectObligation(caller.issueId, parse(ObligationPayload, payload).obligationId, caller.accountId);
    return null;
  }),
);

resolver.define('obligation.reopen', ({ payload, context }) =>
  answer('obligation.reopen', async () => {
    await reopenObligation(callerOf(context).issueId, parse(ObligationPayload, payload).obligationId);
    return null;
  }),
);

resolver.define('obligation.edit', ({ payload, context }) =>
  answer('obligation.edit', async () => {
    const { obligationId, edit } = parse(EditPayload, payload);
    const clean = Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined));
    await editObligation(callerOf(context).issueId, obligationId, clean);
    return null;
  }),
);

resolver.define('terms.edit', ({ payload, context }) =>
  answer('terms.edit', async () => {
    const caller = callerOf(context);
    const { runId, terms, autoRenew } = parse(TermsPayload, payload);
    await editTerms(caller.issueId, runId, { terms, autoRenew }, caller.accountId);
    return null;
  }),
);

// ---- issue panel: decisions and renewal ----

resolver.define('decision.record', ({ payload, context }) =>
  answer('decision.record', () => {
    const caller = callerOf(context);
    const { contractId, outcome, rationale } = parse(DecisionPayload, payload);
    return recordDecision(caller.issueId, contractId, { outcome, rationale }, caller.accountId);
  }),
);

resolver.define('contract.renew', ({ payload, context }) =>
  answer('contract.renew', () => {
    const caller = callerOf(context);
    const { contractId, fromTermIndex } = parse(RenewPayload, payload);
    return markRenewed(caller.issueId, contractId, fromTermIndex, caller.accountId);
  }),
);

resolver.define('contract.undoRenew', ({ payload, context }) =>
  answer('contract.undoRenew', async () => {
    const { contractId, fromTermIndex } = parse(RenewPayload, payload);
    await undoRenewal(callerOf(context).issueId, contractId, fromTermIndex);
    return null;
  }),
);

resolver.define('contract.setCalendar', ({ payload, context }) =>
  answer('contract.setCalendar', () => {
    const caller = callerOf(context);
    const { contractId, name, text } = parse(CalendarPayload, payload);
    return setCalendar(caller.issueId, contractId, name, text, caller.accountId);
  }),
);

// ---- issue panel: details (parties, notices, value, service levels) ----

const briefOf = async (issueId: string, contractId: string, timeZone: string | undefined) => {
  const bundle = await loadBundle(issueId, contractId);
  const today = todayIn(timeZone).today;
  return { bundle, today, brief: buildBrief({ ...bundle, today, leadDays: await getLeadDays() }) };
};

resolver.define('details.read', ({ payload, context }) =>
  answer('details.read', () => queueDetails(callerOf(context).issueId, parse(ContractPayload, payload).contractId)),
);

resolver.define('details.decide', ({ payload, context }) =>
  answer('details.decide', async () => {
    const caller = callerOf(context);
    const { contractId, detailId, decision } = parse(DetailDecisionPayload, payload);
    await decideDetail(await loadBundle(caller.issueId, contractId), detailId, decision, caller.accountId);
    return null;
  }),
);

resolver.define('details.setParty', ({ payload, context }) =>
  answer('details.setParty', async () => {
    const caller = callerOf(context);
    const { contractId, label } = parse(PartyPayload, payload);
    await setOurParty(await loadBundle(caller.issueId, contractId), label, caller.accountId);
    return null;
  }),
);

resolver.define('details.setFilter', ({ payload, context }) =>
  answer('details.setFilter', async () => {
    const caller = callerOf(context);
    const { contractId, jql } = parse(FilterPayload, payload);
    return setSupplierJql(await loadBundle(caller.issueId, contractId), jql, caller.accountId);
  }),
);

resolver.define('details.noticeDraft', ({ payload, context }) =>
  answer('details.noticeDraft', async () => {
    const caller = callerOf(context);
    const { contractId, kind, timeZone } = parse(DraftPayload, payload);
    const { bundle, brief } = await briefOf(caller.issueId, contractId, timeZone);
    return (await noticeDraft(bundle, brief, kind, bundle.contract.issueKey)).draft;
  }),
);

resolver.define('details.supplierRecord', ({ payload, context }) =>
  answer('details.supplierRecord', async () => {
    const caller = callerOf(context);
    const { contractId, timeZone } = parse(ViewerContractPayload, payload);
    const { bundle, brief, today } = await briefOf(caller.issueId, contractId, timeZone);
    return supplierRecord(bundle, brief, today, bundle.contract.issueKey);
  }),
);

resolver.define('details.openClaim', ({ payload, context }) =>
  answer('details.openClaim', async () => {
    const caller = callerOf(context);
    const { contractId, detailId, breachKey, timeZone } = parse(ClaimPayload, payload);
    const { bundle, brief, today } = await briefOf(caller.issueId, contractId, timeZone);
    return openClaimItem(bundle, brief, today, detailId, breachKey, bundle.contract.issueKey);
  }),
);

// Teamwork Graph is read here and only here: when a person opens a brief's context, as that person.
resolver.define('brief.context', ({ payload, context }) =>
  answer('brief.context', () => {
    const caller = callerOf(context);
    const cloudId = (context as { cloudId?: string }).cloudId;
    if (!cloudId) throw new Error('the request has no site id');
    const { contractId, refresh } = parse(ContextPayload, payload);
    return loadContext(caller.issueId, contractId, caller.accountId, cloudId, refresh);
  }),
);

resolver.define('contract.moveDates', ({ payload, context }) =>
  answer('contract.moveDates', () => moveWorkItemDates(callerOf(context).issueId, parse(ContractPayload, payload).contractId)),
);

// ---- register page ----

resolver.define('register.load', ({ payload, context }) =>
  answer('register.load', () => {
    accountOf(context);
    const { windowDays, timeZone } = parse(RegisterPayload, payload);
    return loadRegister(windowDays, todayIn(timeZone).today);
  }),
);

// ---- admin page ----

resolver.define('admin.load', () => answer('admin.load', () => loadAdmin()));

resolver.define('admin.preflight', ({ context }) =>
  answer('admin.preflight', async () => {
    await requireAdmin();
    return runPreflight(accountOf(context));
  }),
);

resolver.define('admin.saveLeadDays', ({ payload, context }) =>
  answer('admin.saveLeadDays', async () => {
    await requireAdmin();
    await setLeadDays(parse(LeadDaysPayload, payload).days, accountOf(context));
    return null;
  }),
);

resolver.define('admin.runDaily', () =>
  answer('admin.runDaily', async () => {
    await requireAdmin();
    return runDailyCheck('manual');
  }),
);

resolver.define('admin.setup', ({ context }) =>
  answer('admin.setup', async () => {
    await requireAdmin();
    return oneClickSetup(accountOf(context));
  }),
);

resolver.define('admin.loadSample', ({ payload, context }) =>
  answer('admin.loadSample', async () => {
    await requireAdmin();
    const { projectId, again } = parse(SamplePayload, payload);
    return startSampleWorkspace(projectId, accountOf(context), again);
  }),
);

export const handler = resolver.getDefinitions();
