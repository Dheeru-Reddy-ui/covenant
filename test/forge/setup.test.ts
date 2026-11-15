import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One-click setup: the project, the Contract work type, a Task work type for the
 * sample's related work, and the sample workspace. Jira and storage are faked.
 */

const site = vi.hoisted(() => ({
  projects: new Map<string, { id: string; key: string; name: string }>(),
  types: [] as Array<{ id: string; name: string; subtask?: boolean; scope?: unknown }>,
  inProject: new Map<string, string[]>(),
  stored: new Map<string, unknown>(),
  samplesStarted: [] as string[],
  nextId: 100,
}));

vi.mock('../../src/forge/db/schema', () => ({ ensureSchema: async () => undefined }));

vi.mock('../../src/forge/settings', () => ({
  SAMPLE_WORKSPACE: 'sample_workspace',
  getJson: async (key: string) => site.stored.get(key) ?? null,
  putJson: async (key: string, value: unknown) => void site.stored.set(key, value),
}));

vi.mock('../../src/forge/admin/sample', () => ({
  startSampleWorkspace: async (projectId: string) => {
    site.samplesStarted.push(projectId);
    site.stored.set('sample_workspace', { status: 'queued', projectKey: 'COVN', startedAtMs: Date.now() });
  },
}));

vi.mock('../../src/forge/jira', () => {
  class JiraError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    JiraError,
    asUser: () => ({}),
    getProject: async (_req: unknown, idOrKey: string) => [...site.projects.values()].find((p) => p.id === idOrKey || p.key === idOrKey) ?? null,
    createProject: async (_req: unknown, p: { key: string; name: string }) => {
      const created = { id: String(site.nextId++), key: p.key, name: p.name };
      site.projects.set(created.id, created);
      site.inProject.set(created.id, ['order']);
      return created;
    },
    listIssueTypes: async () => site.types,
    createIssueType: async (_req: unknown, name: string) => {
      const created = { id: String(site.nextId++), name };
      site.types.push(created);
      return created;
    },
    addIssueTypeToProject: async (_req: unknown, projectId: string, typeId: string) => {
      const ids = site.inProject.get(projectId) ?? [];
      if (ids.includes(typeId)) return false;
      site.inProject.set(projectId, [...ids, typeId]);
      return true;
    },
  };
});

const { oneClickSetup } = await import('../../src/forge/admin/setup');

beforeEach(() => {
  site.projects.clear();
  site.types = [
    { id: 'order', name: 'Order' },
    { id: 'task', name: 'Task' },
    { id: 'sub', name: 'Subtask', subtask: true },
    { id: 'team-task', name: 'Task', scope: { type: 'PROJECT' } },
  ];
  site.inProject.clear();
  site.stored.clear();
  site.samplesStarted = [];
  site.nextId = 100;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('oneClickSetup', () => {
  it('on a fresh site creates the project and Contract type, adds Task for related work, and starts the samples', async () => {
    const result = await oneClickSetup('admin');
    expect(result.project).toEqual({ key: 'COVN', name: 'Contracts', created: true });
    expect(result.workType).toEqual({ name: 'Contract', created: true });
    expect(result.sample).toBe('started');
    expect(result.changed).toBe(true);
    const projectId = [...site.projects.values()][0]!.id;
    const contract = site.types.find((t) => t.name === 'Contract')!;
    expect(site.inProject.get(projectId)).toEqual(['order', contract.id, 'task']);
    expect(result.notes).toContain('Added the Task work type to Contracts, for the related work in the sample workspace.');
    expect(site.samplesStarted).toEqual([projectId]);
  });

  it('changes nothing when clicked again', async () => {
    await oneClickSetup('admin');
    const again = await oneClickSetup('admin');
    expect(again.project.created).toBe(false);
    expect(again.workType).toEqual({ name: 'Contract', created: false });
    expect(again.sample).toBe('loading');
    expect(again.changed).toBe(false);
    expect(again.notes).toEqual([]);
    expect(site.types.filter((t) => t.name === 'Contract')).toHaveLength(1);
  });

  it('adds Task to a project set up before Task was added, without touching the Contract line', async () => {
    site.projects.set('7', { id: '7', key: 'COVN', name: 'Contracts' });
    site.types.push({ id: 'contract', name: 'Contract' });
    site.inProject.set('7', ['order', 'contract']);
    site.stored.set('sample_workspace', { status: 'done', projectKey: 'MOBL' });
    const result = await oneClickSetup('admin');
    expect(result.workType).toEqual({ name: 'Contract', created: false });
    expect(site.inProject.get('7')).toEqual(['order', 'contract', 'task']);
    expect(result.changed).toBe(true);
    expect(result.sample).toBe('already_loaded');
  });

  it('skips Task when the site has no company-wide Task type', async () => {
    site.types = site.types.filter((t) => t.id !== 'task');
    const result = await oneClickSetup('admin');
    const projectId = [...site.projects.values()][0]!.id;
    expect(site.inProject.get(projectId)).not.toContain('team-task');
    expect(result.notes.some((n) => n.includes('Task'))).toBe(false);
    expect(result.workType?.created).toBe(true);
  });
});
