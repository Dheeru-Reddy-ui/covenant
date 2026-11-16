import { describe, expect, it, vi } from 'vitest';

/** editIssue: how Covenant rewrites the letter on a "Send notice by" work item, as the person who clicked. */

vi.mock('@forge/api', () => {
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((path, s, i) => path + s + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
  return { default: { asUser: () => ({}), asApp: () => ({}) }, route };
});

const { JiraError, editIssue } = await import('../../src/forge/jira');

type Call = { path: string; method: string; fields: Record<string, unknown> };

function fakeJira(answer: (fields: Record<string, unknown>) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const requestJira = async (path: string, init?: { method?: string; body?: string }) => {
    const fields = (JSON.parse(init?.body ?? '{}') as { fields: Record<string, unknown> }).fields;
    calls.push({ path, method: init?.method ?? 'GET', fields });
    const { status, body } = answer(fields);
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body ?? {}) };
  };
  return { calls, req: { requestJira } as unknown as Parameters<typeof editIssue>[0] };
}

const fields = { summary: 'Send notice by 2026-12-01: notice of non-renewal', description: { type: 'doc', version: 1, content: [] }, duedate: '2026-12-01' };

describe('editIssue', () => {
  it('saves every field in one edit', async () => {
    const jira = fakeJira(() => ({ status: 204 }));
    expect(await editIssue(jira.req, 'COVN-14', fields)).toEqual({ dueDateSet: true });
    expect(jira.calls).toEqual([{ path: '/rest/api/3/issue/COVN-14', method: 'PUT', fields }]);
  });

  it('saves the rest without Due date when the edit screen leaves it off', async () => {
    const jira = fakeJira((f) => ('duedate' in f ? { status: 400, body: { errors: { duedate: 'Field cannot be set.' } } } : { status: 204 }));
    expect(await editIssue(jira.req, 'COVN-14', fields)).toEqual({ dueDateSet: false });
    expect(jira.calls.map((c) => Object.keys(c.fields))).toEqual([
      ['summary', 'description', 'duedate'],
      ['summary', 'description'],
    ]);
  });

  it('gives up on any other refusal, without a second try', async () => {
    const jira = fakeJira(() => ({ status: 403, body: { errorMessages: ['You do not have permission to edit issues in this project.'] } }));
    await expect(editIssue(jira.req, 'COVN-14', fields)).rejects.toBeInstanceOf(JiraError);
    const other = fakeJira(() => ({ status: 400, body: { errors: { summary: 'Summary is required.' } } }));
    await expect(editIssue(other.req, 'COVN-14', fields)).rejects.toThrow(/summary: Summary is required/);
    expect(jira.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(1);
  });
});
