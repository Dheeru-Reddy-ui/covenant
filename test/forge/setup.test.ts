import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One-click setup: the project, the Contract work type, a Task work type for the
 * sample's related work, a subtask type, and the sample workspace. Jira and
 * storage are faked. The fake project template behaves as task tracking did on
 * a site (17 Nov 2026): it brings company-wide Task and Sub-task, creating them
 * when the site has none. Projects set up before, from the procurement
 * template, had only Order, and setup repairs them.
 */

const site = vi.hoisted(() => ({
  projects: new Map<string, { id: string; key: string; name: string }>(),
  types: [] as Array<{ id: string; name: string; subtask?: boolean; hierarchyLevel?: number; scope?: unknown }>,
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
      readonly fields: string[] = [],
    ) {
      super(message);
    }
  }
  return {
    JiraError,
    asUser: () => ({}),
    getProject: async (_req: unknown, idOrKey: string) => [...site.projects.values()].find((p) => p.id === idOrKey || p.key === idOrKey) ?? null,
    createProject: async (_req: unknown, p: { key: string; name: string }) => {
      if ([...site.projects.values()].some((existing) => existing.name === p.name)) {
        throw new JiraError(400, 'Jira refused creating the project: projectName: A project with that name already exists.', ['projectName']);
      }
      const created = { id: String(site.nextId++), key: p.key, name: p.name };
      site.projects.set(created.id, created);
      const ensure = (name: string, subtask: boolean) => {
        let type = site.types.find((t) => t.scope === undefined && (subtask ? t.subtask === true : t.name === name && t.subtask !== true));
        if (type === undefined) {
          type = { id: `tt-${name.toLowerCase()}`, name, subtask, hierarchyLevel: subtask ? -1 : 0 };
          site.types.push(type);
        }
        return type.id;
      };
      site.inProject.set(created.id, [ensure('Task', false), ensure('Sub-task', true)]);
      return created;
    },
    projectIssueTypes: async (_req: unknown, projectId: string) =>
      (site.inProject.get(projectId) ?? []).flatMap((id) => site.types.filter((t) => t.id === id)),
    listIssueTypes: async () => site.types,
    createIssueType: async (_req: unknown, name: string, _description: string, hierarchyLevel = 0) => {
      const created = { id: String(site.nextId++), name, subtask: hierarchyLevel === -1, hierarchyLevel };
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
    { id: 'sub', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
    { id: 'team-task', name: 'Task', scope: { type: 'PROJECT' } },
    { id: 'team-sub', name: 'Subtask', subtask: true, hierarchyLevel: -1, scope: { type: 'PROJECT' } },
  ];
  site.inProject.clear();
  site.stored.clear();
  site.samplesStarted = [];
  site.nextId = 100;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('oneClickSetup', () => {
  it("on a fresh site creates the project and Contract type, keeps the template's Task and subtask type, and starts the samples", async () => {
    const result = await oneClickSetup('admin');
    expect(result.project).toEqual({ key: 'COVN', name: 'Contracts', created: true });
    expect(result.workType).toEqual({ name: 'Contract', created: true });
    expect(result.sample).toBe('started');
    expect(result.changed).toBe(true);
    const projectId = [...site.projects.values()][0]!.id;
    const contract = site.types.find((t) => t.name === 'Contract')!;
    expect(site.inProject.get(projectId)).toEqual(['task', 'sub', contract.id]);
    expect(result.notes).toEqual([]);
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
    expect(site.inProject.get('7')).toEqual(['order', 'contract', 'task', 'sub']);
    expect(result.changed).toBe(true);
    expect(result.sample).toBe('already_loaded');
  });

  it('adds Subtask to a project set up before Subtask was added, so a second click repairs it', async () => {
    site.projects.set('7', { id: '7', key: 'COVN', name: 'Contracts' });
    site.types.push({ id: 'contract', name: 'Contract' });
    site.inProject.set('7', ['order', 'contract', 'task']);
    site.stored.set('sample_workspace', { status: 'done', projectKey: 'COVN' });
    const result = await oneClickSetup('admin');
    expect(site.inProject.get('7')).toEqual(['order', 'contract', 'task', 'sub']);
    expect(result.changed).toBe(true);
    expect(result.notes).toContain('Added the Subtask work type to Contracts, so approved obligations and reminders can be created under each contract.');
  });

  it('adds no second subtask type when the template brought one, even on a site with only team-managed ones', async () => {
    site.types = site.types.filter((t) => t.id !== 'sub');
    await oneClickSetup('admin');
    const projectId = [...site.projects.values()][0]!.id;
    const companyWide = site.types.filter((t) => t.subtask === true && t.scope === undefined);
    expect(companyWide).toHaveLength(1);
    expect(site.inProject.get(projectId)).toContain(companyWide[0]!.id);
    expect(site.inProject.get(projectId)).not.toContain('team-sub');
    await oneClickSetup('admin');
    expect(site.types.filter((t) => t.subtask === true && t.scope === undefined)).toHaveLength(1);
  });

  it('creates a company-wide Subtask type to repair a project set up before, on a site with only team-managed ones', async () => {
    site.types = site.types.filter((t) => t.id !== 'sub');
    site.projects.set('7', { id: '7', key: 'COVN', name: 'Contracts' });
    site.types.push({ id: 'contract', name: 'Contract' });
    site.inProject.set('7', ['order', 'contract', 'task']);
    site.stored.set('sample_workspace', { status: 'done', projectKey: 'COVN' });
    await oneClickSetup('admin');
    const companyWide = site.types.filter((t) => t.subtask === true && t.scope === undefined);
    expect(companyWide).toHaveLength(1);
    expect(companyWide[0]).toMatchObject({ name: 'Subtask', hierarchyLevel: -1 });
    expect(site.inProject.get('7')).toEqual(['order', 'contract', 'task', companyWide[0]!.id]);
  });

  it('picks another name when the site already has a project called Contracts', async () => {
    site.projects.set('9', { id: '9', key: 'CON', name: 'Contracts' });
    const result = await oneClickSetup('admin');
    expect(result.project).toEqual({ key: 'COVN', name: 'Contracts (Covenant)', created: true });
    expect(result.notes).toContain('A project called "Contracts" already exists, so the new one is called "Contracts (Covenant)".');
    const again = await oneClickSetup('admin');
    expect(again.project).toEqual({ key: 'COVN', name: 'Contracts (Covenant)', created: false });
    expect(site.projects.size).toBe(2);
  });

  it('says what happened when every name it tries is taken', async () => {
    site.projects.set('9', { id: '9', key: 'CON', name: 'Contracts' });
    site.projects.set('10', { id: '10', key: 'CC', name: 'Contracts (Covenant)' });
    site.projects.set('11', { id: '11', key: 'COV', name: 'Covenant contracts' });
    await expect(oneClickSetup('admin')).rejects.toThrow(/already has projects called "Contracts", "Contracts \(Covenant\)" and "Covenant contracts"/);
  });

  it('keeps one company-wide Task when the site has only team-managed ones, as fresh sites do', async () => {
    site.types = site.types.filter((t) => t.id !== 'task');
    await oneClickSetup('admin');
    const projectId = [...site.projects.values()][0]!.id;
    const task = site.types.find((t) => t.name === 'Task' && t.scope === undefined);
    expect(task).toBeDefined();
    expect(site.inProject.get(projectId)).toContain(task!.id);
    expect(site.inProject.get(projectId)).not.toContain('team-task');
    expect(site.types.filter((t) => t.name === 'Task' && t.scope === undefined)).toHaveLength(1);
    await oneClickSetup('admin');
    expect(site.types.filter((t) => t.name === 'Task' && t.scope === undefined)).toHaveLength(1);
  });

  it('creates a company-wide Task type to repair a project set up before, on a site with only team-managed ones', async () => {
    site.types = site.types.filter((t) => t.id !== 'task');
    site.projects.set('7', { id: '7', key: 'COVN', name: 'Contracts' });
    site.types.push({ id: 'contract', name: 'Contract' });
    site.inProject.set('7', ['order', 'contract']);
    site.stored.set('sample_workspace', { status: 'done', projectKey: 'COVN' });
    const result = await oneClickSetup('admin');
    const task = site.types.find((t) => t.name === 'Task' && t.scope === undefined);
    expect(task).toBeDefined();
    expect(site.inProject.get('7')).toContain(task!.id);
    expect(result.notes).toContain('Added the Task work type to Contracts, for the related work in the sample workspace.');
  });
});
