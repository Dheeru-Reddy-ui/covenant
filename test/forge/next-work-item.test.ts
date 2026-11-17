import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClauseRow, ContractRow, ObligationRow, RunRow } from '../../src/forge/db/repo';

/**
 * A recurring obligation's work item covers one date. Once a person finishes
 * it, their click opens the work item for the next date, with the same
 * assignee, and the obligation moves to it. Jira and the database are faked.
 */

const h = vi.hoisted(() => {
  const contract = {
    id: 'contract-1',
    issueId: '10001',
    issueKey: 'COVN-1',
    projectId: '10000',
    attachmentId: '20001',
    sha256: 'ab'.repeat(32),
    fileName: 'sample-quillfeather-msa.docx',
    fileKind: 'docx',
    byteLength: 1000,
    termIndex: 0,
    createdBy: 'someone',
    createdAtMs: 1,
    holidays: { name: 'Weekends only', holidays: [] },
  } as ContractRow;
  const run = {
    id: 'run-1',
    contractId: contract.id,
    paginated: false,
    autoRenew: true,
    terms: { effectiveDate: '2025-03-01', initialTerm: { count: 2, unit: 'year' }, initialTermEnd: null, renewalTerm: { count: 1, unit: 'year' } },
  } as unknown as RunRow;
  const clause = { id: 'clause-1', runId: run.id, contractId: contract.id, role: 'obligation', quote: 'q', page: 1, pageEnd: 1, startOffset: 0, endOffset: 1, occurrences: 1, ambiguous: false, section: null } as ClauseRow;
  const obligation = {
    id: 'obligation-1',
    runId: run.id,
    contractId: contract.id,
    clauseId: clause.id,
    rule: {
      kind: 'reporting_deliverable',
      responsibleParty: 'Supplier',
      summary: 'Deliver a written service level report to Customer.',
      anchor: 'period_end',
      anchorDescription: null,
      offset: { count: 15, unit: 'business_day', direction: 'after' },
      recurrence: { every: { count: 1, unit: 'quarter' }, basis: 'calendar' },
      quote: 'Supplier shall deliver a written service level report within fifteen business days after the end of each calendar quarter.',
      page: 1,
      confidence: 'high',
    },
    decision: 'approved',
    eventDate: null,
    dueDate: '2027-01-21',
    scheduleStatus: 'upcoming',
    workItemId: '20016',
    workItemKey: 'COVN-16',
  } as unknown as ObligationRow;
  return {
    contract,
    run,
    clause,
    obligation,
    finished: { status: 'done', duedate: '2027-01-21' as string | null, assignee: 'acc-1' as string | null },
    failCreate: false,
    calls: [] as Array<{ method: string; path: string; body: unknown }>,
    claim: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    move: vi.fn(async () => true),
    recordCreated: vi.fn(async () => undefined),
  };
});

vi.mock('@forge/api', () => {
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((path, s, i) => path + s + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const requestJira = async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    h.calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : null });
    const subtaskType = { id: '10010', name: 'Sub-task', subtask: true, hierarchyLevel: -1 };
    if (method === 'GET' && path.startsWith('/rest/api/3/issue/20016')) {
      return reply(200, {
        id: '20016',
        key: 'COVN-16',
        fields: {
          project: { id: '10000' },
          issuetype: subtaskType,
          attachment: [],
          status: { statusCategory: { key: h.finished.status } },
          duedate: h.finished.duedate,
          assignee: h.finished.assignee ? { accountId: h.finished.assignee } : null,
        },
      });
    }
    if (method === 'GET' && path.startsWith('/rest/api/3/issue/10001')) {
      return reply(200, { id: '10001', key: 'COVN-1', fields: { project: { id: '10000' }, issuetype: { id: '10005', name: 'Contract', subtask: false, hierarchyLevel: 0 }, attachment: [] } });
    }
    if (method === 'GET' && path.startsWith('/rest/api/3/issuetype/project')) return reply(200, [subtaskType]);
    if (method === 'POST' && path === '/rest/api/3/issue') return h.failCreate ? reply(403, { errorMessages: ['You cannot create work items here.'] }) : reply(201, { id: '20020', key: 'COVN-20' });
    if (method === 'PUT' && path === '/rest/api/3/issue/COVN-20') return reply(204, null);
    return reply(500, { errorMessages: ['unexpected call in test'] });
  };
  const requester = { requestJira };
  return { default: { asUser: () => requester, asApp: () => requester }, route };
});

vi.mock('../../src/forge/db/schema', () => ({ ensureSchema: async () => undefined }));

vi.mock('../../src/forge/db/repo', () => ({
  findObligationByWorkItem: async (issueId: string) => (issueId === '20016' || issueId === h.obligation.workItemId ? h.obligation : null),
  getRun: async () => h.run,
  getContract: async () => h.contract,
  getClause: async () => h.clause,
  claimWorkItemMove: h.claim,
  releaseWorkItemMove: h.release,
  moveToNextWorkItem: h.move,
  recordCreatedItem: h.recordCreated,
}));

const { openNextWorkItem } = await import('../../src/forge/review/actions');

const saved = { ...h.obligation };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  h.calls.length = 0;
  h.finished = { status: 'done', duedate: '2027-01-21', assignee: 'acc-1' };
  h.failCreate = false;
  for (const f of [h.claim, h.release, h.move, h.recordCreated]) f.mockClear();
  h.claim.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  Object.assign(h.obligation, saved);
});

const created = () => h.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue');

describe('openNextWorkItem', () => {
  it('opens the work item for the next quarter under the contract, with the same assignee, and moves the obligation to it', async () => {
    const result = await openNextWorkItem('20016');
    expect(result).toEqual({ key: 'COVN-20', dueDate: '2027-04-21', created: true, assigned: true });
    const [post] = created();
    expect(post?.body).toMatchObject({ fields: { parent: { key: 'COVN-1' }, issuetype: { id: '10010' }, duedate: '2027-04-21' } });
    expect(h.calls).toContainEqual({ method: 'PUT', path: '/rest/api/3/issue/COVN-20', body: { fields: { assignee: { accountId: 'acc-1' } } } });
    expect(h.claim).toHaveBeenCalledWith('obligation-1', { id: '20016', key: 'COVN-16' }, '2027-01-21', expect.any(Number));
    expect(h.move).toHaveBeenCalledWith('obligation-1', '20016', expect.objectContaining({ id: '20020', key: 'COVN-20' }), '2027-04-21', 'upcoming', expect.any(Number));
    expect(h.recordCreated).toHaveBeenCalledWith('COVN-20', 'contract-1', 'obligation', expect.any(Number));
  });

  it('leaves the new item unassigned when the finished one had nobody', async () => {
    h.finished.assignee = null;
    expect(await openNextWorkItem('20016')).toMatchObject({ key: 'COVN-20', assigned: false });
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('opens nothing until the work item is done in Jira', async () => {
    h.finished.status = 'indeterminate';
    await expect(openNextWorkItem('20016')).rejects.toThrow(/Finish COVN-16 in Jira first/);
    expect(created()).toEqual([]);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('gives back the open item when clicked on an earlier date, without creating another', async () => {
    Object.assign(h.obligation, { workItemId: '20020', workItemKey: 'COVN-20', dueDate: '2027-04-21' });
    expect(await openNextWorkItem('20016')).toEqual({ key: 'COVN-20', dueDate: '2027-04-21', created: false, assigned: false });
    expect(created()).toEqual([]);
  });

  it('creates nothing when another click claimed the move first', async () => {
    h.claim.mockResolvedValue(false);
    await expect(openNextWorkItem('20016')).rejects.toThrow(/already being opened/);
    expect(created()).toEqual([]);
  });

  it('gives the claim back when Jira refuses, so the person can try again', async () => {
    h.failCreate = true;
    await expect(openNextWorkItem('20016')).rejects.toThrow(/permission|cannot create/i);
    expect(h.release).toHaveBeenCalledWith('20016');
    expect(h.move).not.toHaveBeenCalled();
  });

  it('refuses a one-off obligation, which has no next date', async () => {
    Object.assign(h.obligation, { rule: { ...h.obligation.rule, recurrence: null } });
    await expect(openNextWorkItem('20016')).rejects.toThrow(/falls due once/);
  });
});
