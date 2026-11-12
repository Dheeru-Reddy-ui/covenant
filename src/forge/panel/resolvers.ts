import Resolver from '@forge/resolver';
import { z } from 'zod';
import { AnchorEventSchema, ObligationKindSchema, OffsetSchema } from '../../../packages/core/src';
import type { Reply } from '../../shared/panel';
import { loggableError, readableError } from '../errors';
import { startExtraction } from '../pipeline/start';
import { approveObligation, editObligation, editTerms, rejectObligation, reopenObligation } from '../review/actions';
import { loadPanel } from './view';

/**
 * Resolvers behind the Covenant issue panel. Each one reads the work item from
 * the panel's context (never from the payload) and answers with
 * { ok, data } or { ok: false, error } in words a reviewer can act on.
 */

interface PanelContext {
  accountId?: string;
  extension?: { issue?: { id?: string | number; key?: string } };
}

interface Caller {
  issueId: string;
  accountId: string;
}

function callerOf(context: unknown): Caller {
  const c = context as PanelContext;
  const issueId = c.extension?.issue?.id;
  if (issueId === undefined || c.accountId === undefined) throw new Error('the panel context has no work item or user');
  return { issueId: String(issueId), accountId: c.accountId };
}

async function answer<T>(name: string, run: () => Promise<T>): Promise<Reply<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    console.error(`resolver ${name} failed error=${loggableError(error)}`);
    return { ok: false, error: readableError(error, 'Something went wrong. Reload the panel and try again.') };
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

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error('the request was malformed');
  return result.data;
}

const resolver = new Resolver();

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

export const handler = resolver.getDefinitions();
