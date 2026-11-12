import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClauseRow, ContractRow, ObligationRow, RunRow } from '../../src/forge/db/repo';

/**
 * Phase 4: a person who cannot see a contract's work item gets nothing about
 * it from any tool. The tools run for real; only Jira, the database and
 * Teamwork Graph are faked. Jira answers 404 for a hidden work item, exactly as
 * it does for one that does not exist.
 */

const h = vi.hoisted(() => {
  const contract: ContractRow = {
    id: 'contract-7f3a',
    issueId: '10001',
    issueKey: 'LEGAL-1',
    projectId: '10000',
    attachmentId: '20001',
    sha256: 'ab'.repeat(32),
    fileName: 'acme-msa-confidential.pdf',
    fileKind: 'pdf',
    byteLength: 12345,
    termIndex: 0,
    createdBy: 'someone-else',
    createdAtMs: 1_760_000_000_000,
  };
  const quote = 'unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.';
  const rule = {
    kind: 'renewal_notice',
    responsibleParty: 'Either party',
    summary: 'Give written notice of non-renewal to Acme before the term ends.',
    anchor: 'term_end',
    anchorDescription: null,
    offset: { count: 90, unit: 'day', direction: 'before' },
    recurrence: null,
    quote,
    page: 2,
    confidence: 'high',
  } as unknown as ObligationRow['rule'];
  const run = {
    id: 'run-1',
    contractId: contract.id,
    extractorVersion: 3,
    schemaVersion: 1,
    model: 'claude-haiku-4-5-20251001',
    status: 'needs_review',
    jobId: null,
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    inputTokens: 1,
    outputTokens: 1,
    llmCalls: 1,
    secondPasses: 0,
    repaired: false,
    quotesReturned: 1,
    quotesVerified: 1,
    rejectedCount: 0,
    pages: 2,
    chars: 1000,
    paginated: true,
    facts: null,
    terms: {
      effectiveDate: '2025-03-01',
      initialTerm: { count: 2, unit: 'year' },
      initialTermEnd: null,
      renewalTerm: { count: 1, unit: 'year' },
    },
    autoRenew: true,
    requestedBy: 'someone-else',
    queuedAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 1,
    updatedAtMs: 1,
  } as RunRow;
  const clause: ClauseRow = {
    id: 'clause-1',
    runId: run.id,
    contractId: contract.id,
    role: 'obligation',
    quote,
    page: 2,
    pageEnd: 2,
    startOffset: 10,
    endOffset: 140,
    occurrences: 1,
    ambiguous: false,
    section: { label: 'clause', number: '2.2', heading: 'Renewal' },
  };
  const obligation: ObligationRow = {
    id: 'obligation-9c1',
    runId: run.id,
    contractId: contract.id,
    clauseId: clause.id,
    ordinal: 0,
    rule,
    originalRule: rule,
    secondRule: null,
    extractorStatus: 'ready',
    review: [],
    decision: 'pending',
    eventDate: null,
    dueDate: null,
    scheduleStatus: 'upcoming',
    workItemId: null,
    workItemKey: null,
    lastError: null,
    decidedBy: null,
    decidedAtMs: null,
    updatedAtMs: 1,
  };
  return {
    contract,
    run,
    clause,
    obligation,
    title: 'Acme Corp master services agreement',
    jira: { visible: false, calls: [] as Array<{ method: string; path: string }> },
    insertDecision: vi.fn(async () => undefined),
    loadContext: vi.fn(async () => ({ fetchedAtMs: 0, cached: false, related: [], goals: [], teams: [], owners: [], problems: [] })),
  };
});

vi.mock('@forge/api', () => {
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((path, s, i) => path + s + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const requestJira = async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    h.jira.calls.push({ method, path });
    if (path.startsWith('/rest/api/3/serverInfo')) return reply(200, { baseUrl: 'https://example.atlassian.net' });
    if (method === 'GET' && path.startsWith('/rest/api/3/issue/')) {
      const target = decodeURIComponent(path.slice('/rest/api/3/issue/'.length).split('?')[0] ?? '');
      const known = target === h.contract.issueId || target === h.contract.issueKey;
      return h.jira.visible && known
        ? reply(200, { id: h.contract.issueId, key: h.contract.issueKey, fields: { summary: h.title } })
        : reply(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
    }
    if (path.startsWith('/rest/api/3/search/jql')) return reply(200, { issues: [] });
    return reply(500, { errorMessages: ['unexpected call in test'] });
  };
  const requester = {
    requestJira,
    requestTeamworkGraph: async () => {
      throw new Error('Teamwork Graph must not be called in this test');
    },
  };
  return { default: { asUser: () => requester, asApp: () => requester }, route };
});

vi.mock('../../src/forge/db/schema', () => ({ ensureSchema: async () => undefined }));

vi.mock('../../src/forge/decisions/context', () => ({ loadContext: h.loadContext }));

vi.mock('../../src/forge/db/repo', () => ({
  listLatestReviewableRuns: async () => [h.run],
  listAllContracts: async () => [h.contract],
  listObligationsForRuns: async () => [h.obligation],
  listClausesForRuns: async () => [h.clause],
  listObligations: async () => [h.obligation],
  listClauses: async () => [h.clause],
  latestRun: async () => h.run,
  getObligation: async (id: string) => (id === h.obligation.id ? h.obligation : null),
  getContract: async (id: string) => (id === h.contract.id ? h.contract : null),
  getClause: async (id: string) => (id === h.clause.id ? h.clause : null),
  getRun: async (id: string) => (id === h.run.id ? h.run : null),
  listContractsForIssue: async (issueId: string) => (issueId === h.contract.issueId ? [h.contract] : []),
  getContractState: async (contractId: string) => ({
    contractId,
    noticeDeadline: null,
    noticeStatus: null,
    windowCheckedAtMs: null,
    decisionItemKey: null,
    decisionItemTerm: null,
    decisionItemClaimedAtMs: null,
    renewedBy: null,
    renewedAtMs: null,
  }),
  listDecisionsForContract: async () => [],
  getCachedContext: async () => null,
  insertDecision: h.insertDecision,
  getSetting: async () => null,
}));

const { getClauseTool, getRenewalBriefTool, listObligationsTool, recordDecisionTool } = await import('../../src/forge/tools/actions');

const caller = { principal: { accountId: 'outsider-1' }, installContext: 'ari:cloud:jira::site/0f0e0d0c-1111-2222-3333-444455556666' };
const envelope = { context: { cloudId: '0f0e0d0c-1111-2222-3333-444455556666', moduleKey: 'covenant-mcp' } };
const rationale = 'Usage grew this year and the price is unchanged.';

/** Anything that identifies the contract or quotes it. Inputs the caller typed themselves are allowed back. */
const SECRETS = [h.clause.quote, h.contract.fileName, h.title, h.contract.id, 'Acme', 'non-renewal'];
const leaked = (reply: unknown): string[] => SECRETS.filter((s) => JSON.stringify(reply).includes(s));
const writes = () => h.jira.calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  h.jira.visible = false;
  h.jira.calls.length = 0;
  h.insertDecision.mockClear();
  h.loadContext.mockClear();
});

describe('a person who cannot see the contract work item', () => {
  it('gets an empty list from list_obligations, whatever the filters', async () => {
    for (const input of [{}, { kind: 'notice', withinDays: 90 }, { contract: 'acme' }, { status: 'needs_review', limit: 100 }]) {
      const reply = await listObligationsTool({ ...envelope, ...input }, caller);
      expect(reply).toMatchObject({ ok: true, matched: 0, returned: 0, obligations: [] });
      expect(leaked(reply)).toEqual([]);
    }
  });

  it('gets the same answer from get_clause as for an id that does not exist', async () => {
    const hidden = await getClauseTool({ ...envelope, obligationId: h.obligation.id }, caller);
    const missing = await getClauseTool({ ...envelope, obligationId: 'no-such-obligation' }, caller);
    expect(hidden.ok).toBe(false);
    expect(leaked(hidden)).toEqual([]);
    expect(JSON.stringify(hidden).replace(h.obligation.id, 'ID')).toEqual(JSON.stringify(missing).replace('no-such-obligation', 'ID'));
  });

  it('gets the same answer from get_renewal_brief as for a work item that does not exist, and no graph context is loaded', async () => {
    const hidden = await getRenewalBriefTool({ ...envelope, contract: 'LEGAL-1' }, caller);
    const missing = await getRenewalBriefTool({ ...envelope, contract: 'LEGAL-999' }, caller);
    expect(hidden.ok).toBe(false);
    expect(leaked(hidden)).toEqual([]);
    expect(JSON.stringify(hidden).replace('LEGAL-1', 'KEY')).toEqual(JSON.stringify(missing).replace('LEGAL-999', 'KEY'));
    expect(h.loadContext).not.toHaveBeenCalled();
  });

  it('cannot preview or record a decision, even with confirm set', async () => {
    for (const confirm of [undefined, true]) {
      const reply = await recordDecisionTool({ ...envelope, contract: 'LEGAL-1', outcome: 'terminate', rationale, confirm }, caller);
      expect(reply.ok).toBe(false);
      expect(reply).not.toHaveProperty('wouldRecord');
      expect(leaked(reply)).toEqual([]);
    }
    expect(h.insertDecision).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('gets nothing at all when the platform does not say who is calling', async () => {
    const reply = await listObligationsTool({ ...envelope }, { installContext: caller.installContext });
    expect(reply.ok).toBe(false);
    expect(leaked(reply)).toEqual([]);
    expect(h.jira.calls).toEqual([]);
  });
});

describe('the same tools for a person who can see it (so the checks above are not vacuous)', () => {
  beforeEach(() => {
    h.jira.visible = true;
  });

  it('lists the obligation with its verbatim clause', async () => {
    const reply = await listObligationsTool({ ...envelope, kind: 'notice' }, caller);
    expect(reply).toMatchObject({ ok: true, matched: 1 });
    expect(JSON.stringify(reply)).toContain(JSON.stringify(h.clause.quote).slice(1, -1));
  });

  it('returns the clause from get_clause', async () => {
    const reply = await getClauseTool({ ...envelope, obligationId: h.obligation.id }, caller);
    expect(reply).toMatchObject({
      ok: true,
      citation: { quote: h.clause.quote, location: 'clause 2.2 (Renewal), page 2', clause: '2.2', clauseHeading: 'Renewal', page: 2 },
    });
  });

  it('previews a decision without confirm and records it only with confirm', async () => {
    const preview = await recordDecisionTool({ ...envelope, contract: 'LEGAL-1', outcome: 'renew', rationale }, caller);
    expect(preview).toMatchObject({ ok: false, recorded: false, refused: 'confirmation_required' });
    expect(h.insertDecision).not.toHaveBeenCalled();

    const done = await recordDecisionTool({ ...envelope, contract: 'LEGAL-1', outcome: 'renew', rationale, confirm: true }, caller);
    expect(done).toMatchObject({ ok: true, recorded: true });
    expect(h.insertDecision).toHaveBeenCalledTimes(1);
  });
});
