import Resolver from '@forge/resolver';
import { z } from 'zod';
import { AnchorEventSchema, DECISION_OUTCOMES, ObligationKindSchema, OffsetSchema } from '../../packages/core/src';
import type { Reply } from '../shared/panel';
import { runPreflight } from './admin/preflight';
import { startSampleWorkspace } from './admin/sample';
import { loadAdmin, requireAdmin } from './admin/view';
import { markRenewed, moveWorkItemDates, recordDecision, undoRenewal } from './decisions/actions';
import { loadContext } from './decisions/context';
import { loggableError, readableError } from './errors';
import { runDailyCheck } from './jobs/daily';
import { loadPanel } from './panel/view';
import { startExtraction } from './pipeline/start';
import { loadRegister } from './register/view';
import { approveObligation, editObligation, editTerms, rejectObligation, reopenObligation } from './review/actions';
import { setLeadDays } from './settings';

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
const ContextPayload = z.object({ contractId: Id, refresh: z.boolean() });
const RegisterPayload = z.object({ windowDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.null()]) });
const LeadDaysPayload = z.object({ days: z.number().int() });
const SamplePayload = z.object({ projectId: Id, again: z.boolean() });

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error('the request was malformed');
  return result.data;
}

const resolver = new Resolver();

// ---- issue panel: extraction and review ----

resolver.define('panel.load', ({ context }) => answer('panel.load', () => loadPanel(callerOf(context).issueId)));

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
    return loadRegister(parse(RegisterPayload, payload).windowDays);
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

resolver.define('admin.loadSample', ({ payload, context }) =>
  answer('admin.loadSample', async () => {
    await requireAdmin();
    const { projectId, again } = parse(SamplePayload, payload);
    return startSampleWorkspace(projectId, accountOf(context), again);
  }),
);

export const handler = resolver.getDefinitions();
