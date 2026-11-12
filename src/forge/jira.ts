import api, { route } from '@forge/api';
import type { AdfDoc, IsoDate } from '../../packages/core/src';

/**
 * Jira REST calls. Resolvers call as the signed-in user, so Jira's own
 * permissions apply; the queue worker has no user and calls as the app.
 * Errors carry Jira's status and field names, never contract text.
 */

export type Requester = Pick<ReturnType<typeof api.asApp>, 'requestJira'>;

export const asUser = (): Requester => api.asUser();
export const asApp = (): Requester => api.asApp();

export class JiraError extends Error {
  override name = 'JiraError';
  constructor(
    readonly status: number,
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

interface JiraErrorBody {
  errorMessages?: string[];
  errors?: Record<string, string>;
}

async function failure(response: { status: number; text: () => Promise<string> }, doing: string): Promise<JiraError> {
  let body: JiraErrorBody = {};
  try {
    body = JSON.parse(await response.text()) as JiraErrorBody;
  } catch {
    // Not JSON: the status says enough.
  }
  const fields = Object.keys(body.errors ?? {});
  const details = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([field, text]) => `${field}: ${text}`)];
  const why =
    response.status === 401 || response.status === 403
      ? 'you do not have permission'
      : response.status === 404
        ? 'it was not found or you cannot see it'
        : details.join('; ') || `HTTP ${response.status}`;
  return new JiraError(response.status, `Jira refused ${doing}: ${why}`.slice(0, 900), fields);
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface IssueInfo {
  id: string;
  key: string;
  projectId: string;
  issueType: { id: string; name: string; subtask: boolean; hierarchyLevel: number };
  attachments: Attachment[];
}

interface IssueResponse {
  id: string;
  key: string;
  fields?: {
    attachment?: Attachment[];
    project?: { id: string };
    issuetype?: { id: string; name: string; subtask?: boolean; hierarchyLevel?: number };
  };
}

export async function getIssue(req: Requester, issueIdOrKey: string): Promise<IssueInfo> {
  const response = await req.requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=attachment,project,issuetype`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw await failure(response, 'reading the work item');
  const issue = (await response.json()) as IssueResponse;
  const type = issue.fields?.issuetype;
  return {
    id: issue.id,
    key: issue.key,
    projectId: issue.fields?.project?.id ?? '',
    issueType: {
      id: type?.id ?? '',
      name: type?.name ?? '',
      subtask: type?.subtask ?? false,
      hierarchyLevel: type?.hierarchyLevel ?? (type?.subtask ? -1 : 0),
    },
    attachments: (issue.fields?.attachment ?? []).map((a) => ({ id: String(a.id), filename: a.filename, mimeType: a.mimeType, size: a.size })),
  };
}

/** Whether the caller can see a work item. Deleted and hidden items look the same to Jira: both are a no. */
export async function canSeeIssue(req: Requester, issueIdOrKey: string): Promise<boolean> {
  const response = await req.requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=summary`, { headers: { Accept: 'application/json' } });
  if (response.ok) return true;
  if (response.status === 403 || response.status === 404) return false;
  throw await failure(response, 'checking access to a work item');
}

export async function downloadAttachment(req: Requester, attachmentId: string): Promise<Uint8Array> {
  // redirect=false makes Jira return the bytes itself instead of a 303 to the media service (spike S1).
  const response = await req.requestJira(route`/rest/api/3/attachment/content/${attachmentId}?redirect=false`);
  if (!response.ok) throw await failure(response, 'downloading the attachment');
  return new Uint8Array(await response.arrayBuffer());
}

export interface IssueTypeResponse {
  id: string;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

/**
 * The issue type a child of `parent` should have: a subtask type under a
 * standard work item, a standard type (Task if there is one) under an epic.
 */
export async function childIssueType(req: Requester, parent: IssueInfo): Promise<{ id: string; name: string }> {
  if (parent.issueType.subtask || parent.issueType.hierarchyLevel < 0) {
    throw new JiraError(400, `${parent.key} is a subtask, and Jira does not allow work items under a subtask. Attach the contract to its parent instead.`);
  }
  const response = await req.requestJira(route`/rest/api/3/issuetype/project?projectId=${parent.projectId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw await failure(response, 'listing the project\'s work types');
  const types = (await response.json()) as IssueTypeResponse[];
  const childLevel = parent.issueType.hierarchyLevel - 1;
  const candidates = types.filter((t) => (t.hierarchyLevel ?? (t.subtask ? -1 : 0)) === childLevel);
  const pick = candidates.find((t) => /^(sub-?task|task)$/i.test(t.name)) ?? candidates[0];
  if (pick === undefined) {
    throw new JiraError(400, `this project has no work type that can sit under a ${parent.issueType.name}`);
  }
  return { id: pick.id, name: pick.name };
}

export interface ChildRequest {
  projectId: string;
  parentKey: string;
  issueTypeId: string;
  summary: string;
  description: AdfDoc;
  dueDate: IsoDate | null;
}

export interface CreatedChild {
  id: string;
  key: string;
  /** False when the project's screens would not take a due date. The date is still in the description. */
  dueDateSet: boolean;
}

export async function postIssue(req: Requester, fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
  const response = await req.requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw await failure(response, 'creating the work item');
  return (await response.json()) as { id: string; key: string };
}

/**
 * Creates the child. Some projects leave Due date off the create screen, which
 * makes Jira reject the field; then the item is created without it and the
 * date is set with an edit, which uses the edit screen instead.
 */
export async function createChild(req: Requester, child: ChildRequest): Promise<CreatedChild> {
  const fields: Record<string, unknown> = {
    project: { id: child.projectId },
    parent: { key: child.parentKey },
    issuetype: { id: child.issueTypeId },
    summary: child.summary,
    description: child.description,
  };
  if (child.dueDate === null) return { ...(await postIssue(req, fields)), dueDateSet: false };

  try {
    return { ...(await postIssue(req, { ...fields, duedate: child.dueDate })), dueDateSet: true };
  } catch (error) {
    if (!(error instanceof JiraError && error.status === 400 && error.fields.includes('duedate'))) throw error;
  }

  const created = await postIssue(req, fields);
  const edit = await req.requestJira(route`/rest/api/3/issue/${created.key}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { duedate: child.dueDate } }),
  });
  return { ...created, dueDateSet: edit.ok };
}

export async function updateDueDate(req: Requester, issueKey: string, dueDate: IsoDate | null): Promise<void> {
  const response = await req.requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { duedate: dueDate } }),
  });
  if (!response.ok) throw await failure(response, `changing the due date of ${issueKey}`);
}

export async function addComment(req: Requester, issueKey: string, body: AdfDoc): Promise<void> {
  const response = await req.requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw await failure(response, `commenting on ${issueKey}`);
}

export interface FoundIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  issueType: string;
  labels: string[];
  assignee: Person | null;
  reporter: Person | null;
  updated: string | null;
}

/** accountType is "app" for app users, such as Covenant itself when it created a work item. */
export interface Person {
  accountId: string;
  displayName: string;
  accountType: string;
}

interface SearchResponse {
  issues?: Array<{
    id: string;
    key: string;
    fields?: {
      summary?: string;
      status?: { name?: string; statusCategory?: { key?: string } };
      issuetype?: { name?: string };
      labels?: string[];
      assignee?: { accountId: string; displayName: string; accountType?: string } | null;
      reporter?: { accountId: string; displayName: string; accountType?: string } | null;
      updated?: string;
    };
  }>;
  nextPageToken?: string;
}

const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'labels', 'assignee', 'reporter', 'updated'];

/** JQL search, following nextPageToken up to `max` results. Runs with the caller's permissions. */
export async function searchIssues(req: Requester, jql: string, max = 100): Promise<FoundIssue[]> {
  const found: FoundIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const response = await req.requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, fields: SEARCH_FIELDS, maxResults: Math.min(100, max - found.length), ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    if (!response.ok) throw await failure(response, 'searching for work items');
    const page = (await response.json()) as SearchResponse;
    for (const issue of page.issues ?? []) {
      const f = issue.fields ?? {};
      found.push({
        id: String(issue.id),
        key: issue.key,
        summary: f.summary ?? '',
        status: f.status?.name ?? '',
        statusCategory: f.status?.statusCategory?.key ?? '',
        issueType: f.issuetype?.name ?? '',
        labels: f.labels ?? [],
        assignee: f.assignee ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName, accountType: f.assignee.accountType ?? 'atlassian' } : null,
        reporter: f.reporter ? { accountId: f.reporter.accountId, displayName: f.reporter.displayName, accountType: f.reporter.accountType ?? 'atlassian' } : null,
        updated: f.updated ?? null,
      });
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && found.length < max);
  return found;
}

export interface ProjectInfo {
  id: string;
  key: string;
  name: string;
}

/** Projects the caller can create work items in. */
export async function listCreatableProjects(req: Requester): Promise<ProjectInfo[]> {
  const response = await req.requestJira(route`/rest/api/3/project/search?action=create&maxResults=50&orderBy=name`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw await failure(response, 'listing projects');
  const page = (await response.json()) as { values?: Array<{ id: string; key: string; name: string }> };
  return (page.values ?? []).map((p) => ({ id: String(p.id), key: p.key, name: p.name }));
}

/** The HTTP status of a cheap Jira call, to tell whether Jira answers this caller at all. */
export async function jiraStatus(req: Requester): Promise<number> {
  const response = await req.requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } });
  return response.status;
}

/** True when the caller is a Jira administrator. */
export async function isJiraAdmin(req: Requester): Promise<boolean> {
  const response = await req.requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return false;
  const body = (await response.json()) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
  return body.permissions?.ADMINISTER?.havePermission === true;
}

export async function projectIssueTypes(req: Requester, projectId: string): Promise<IssueTypeResponse[]> {
  const response = await req.requestJira(route`/rest/api/3/issuetype/project?projectId=${projectId}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw await failure(response, "listing the project's work types");
  return (await response.json()) as IssueTypeResponse[];
}

export async function linkIssues(req: Requester, fromKey: string, toKey: string): Promise<void> {
  const response = await req.requestJira(route`/rest/api/3/issueLink`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: { name: 'Relates' }, inwardIssue: { key: fromKey }, outwardIssue: { key: toKey } }),
  });
  if (!response.ok) throw await failure(response, `linking ${fromKey} to ${toKey}`);
}

/**
 * Attaches a file. The multipart body is built by hand as plain bytes: Forge
 * developers report FormData bodies arriving rejected or corrupted, and bytes
 * leave nothing for the runtime to re-encode. Returns the new attachment's id.
 */
export async function uploadAttachment(req: Requester, issueKey: string, fileName: string, contentType: string, bytes: Uint8Array): Promise<string> {
  const boundary = `covenant${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const safeName = fileName.replace(/["\r\n]/g, '_');
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const response = await req.requestJira(route`/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'X-Atlassian-Token': 'no-check', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    // `body` was allocated at exactly this length, so its buffer holds nothing else.
    body: body.buffer,
  });
  if (!response.ok) throw await failure(response, `attaching ${safeName} to ${issueKey}`);
  const created = (await response.json()) as Array<{ id: string }>;
  const first = created[0];
  if (first === undefined) throw new JiraError(500, `Jira accepted the attachment for ${issueKey} but returned no attachment`);
  return String(first.id);
}
