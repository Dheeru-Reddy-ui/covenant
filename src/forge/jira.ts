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

export async function downloadAttachment(req: Requester, attachmentId: string): Promise<Uint8Array> {
  // redirect=false makes Jira return the bytes itself instead of a 303 to the media service (spike S1).
  const response = await req.requestJira(route`/rest/api/3/attachment/content/${attachmentId}?redirect=false`);
  if (!response.ok) throw await failure(response, 'downloading the attachment');
  return new Uint8Array(await response.arrayBuffer());
}

interface IssueTypeResponse {
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

async function postIssue(req: Requester, fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
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
