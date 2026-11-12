import { Queue } from '@forge/events';
import type { AsyncEvent } from '@forge/events';
import type { AdfDoc } from '../../../packages/core/src';
import { sampleWorkspace } from '../../../samples/fictional/workspace';
import { sha256Hex } from '../../parse/document';
import { DOCX_TYPE, buildContractDocx } from '../../sample/docx';
import type { SampleStatus } from '../../shared/admin';
import { todayUtc } from '../dates';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError, readableError } from '../errors';
import {
  type IssueTypeResponse,
  JiraError,
  type Requester,
  asApp,
  asUser,
  downloadAttachment,
  linkIssues,
  listCreatableProjects,
  postIssue,
  projectIssueTypes,
  uploadAttachment,
} from '../jira';
import { startExtraction } from '../pipeline/start';
import { SAMPLE_WORKSPACE, getJson, putJson } from '../settings';

/**
 * "Load sample workspace": three fictional contracts on new work items, each
 * with its Word file attached, plus related work and incidents linked to them,
 * then each contract queued for extraction through the normal pipeline.
 * The admin's click only queues the job; a queue worker does the work as the app.
 */

export const SAMPLE_QUEUE = 'covenant-sample';
const LABEL = 'covenant-sample';
const STALE_MS = 15 * 60 * 1000;

const queue = new Queue({ key: SAMPLE_QUEUE });

export async function startSampleWorkspace(projectId: string, accountId: string, again: boolean): Promise<SampleStatus> {
  await ensureSchema();
  const current = await getJson<SampleStatus>(SAMPLE_WORKSPACE);
  if (current !== null && (current.status === 'queued' || current.status === 'running') && Date.now() - current.startedAtMs < STALE_MS) {
    throw new UserFacingError('The sample workspace is already loading. Wait for it to finish.');
  }
  if (current?.status === 'done' && !again) {
    throw new UserFacingError(`The sample workspace is already loaded in ${current.projectKey}. Choose "Load again" to create a second copy.`);
  }
  const project = (await listCreatableProjects(asUser())).find((p) => p.id === projectId);
  if (project === undefined) throw new UserFacingError('You cannot create work items in that project. Choose another one.');

  const status: SampleStatus = {
    status: 'queued',
    projectKey: project.key,
    startedAtMs: Date.now(),
    finishedAtMs: null,
    contracts: [],
    related: [],
    step: 'Queued',
    error: null,
  };
  await putJson(SAMPLE_WORKSPACE, status, accountId);
  await queue.push({ body: { projectId: project.id, projectKey: project.key, accountId } });
  console.log(`sample workspace queued project=${project.id}`);
  return status;
}

const doc = (...paragraphs: string[]): AdfDoc => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

function pickTypes(types: IssueTypeResponse[]): { task: IssueTypeResponse; incident: IssueTypeResponse } {
  const standard = types.filter((t) => (t.hierarchyLevel ?? (t.subtask ? -1 : 0)) === 0);
  const task = standard.find((t) => /^task$/i.test(t.name)) ?? standard[0];
  if (task === undefined) throw new UserFacingError('That project has no standard work type to create sample items with.');
  const incident = standard.find((t) => /incident/i.test(t.name)) ?? standard.find((t) => /^bug$/i.test(t.name)) ?? task;
  return { task, incident };
}

/** Creates a work item assigned to the admin, or unassigned when the project will not take that assignee. */
async function createAssigned(req: Requester, fields: Record<string, unknown>, accountId: string): Promise<{ id: string; key: string }> {
  try {
    return await postIssue(req, { ...fields, assignee: { accountId } });
  } catch (error) {
    if (error instanceof JiraError && error.status === 400 && error.fields.includes('assignee')) return postIssue(req, fields);
    throw error;
  }
}

interface SampleEventBody {
  projectId?: unknown;
  projectKey?: unknown;
  accountId?: unknown;
  [key: string]: unknown;
}

export async function sampleWorker(event: AsyncEvent<SampleEventBody>): Promise<void> {
  const { projectId, projectKey, accountId } = event.body ?? {};
  if (typeof projectId !== 'string' || typeof projectKey !== 'string' || typeof accountId !== 'string') {
    console.error('sample event without a project or account');
    return;
  }
  const started = Date.now();
  await ensureSchema();
  const status: SampleStatus = (await getJson<SampleStatus>(SAMPLE_WORKSPACE)) ?? {
    status: 'queued',
    projectKey,
    startedAtMs: started,
    finishedAtMs: null,
    contracts: [],
    related: [],
    step: '',
    error: null,
  };
  const save = async (step: string) => {
    status.step = step;
    await putJson(SAMPLE_WORKSPACE, status, accountId);
  };
  status.status = 'running';
  await save('Reading the project');

  try {
    const req = asApp();
    const { task, incident } = pickTypes(await projectIssueTypes(req, projectId));
    for (const contract of sampleWorkspace(todayUtc())) {
      await save(`Creating "${contract.workItemSummary}"`);
      const item = await createAssigned(
        req,
        {
          project: { id: projectId },
          issuetype: { id: task.id },
          summary: contract.workItemSummary,
          description: doc(
            'A fictional contract loaded by Covenant\'s sample workspace. The attached Word file is invented for testing.',
            'Open this work item\'s Covenant panel (View app actions, then Covenant) and click Extract, or see the review it has already queued.',
          ),
          labels: [LABEL],
        },
        accountId,
      );

      await save(`Attaching ${contract.fileName} to ${item.key}`);
      const bytes = await buildContractDocx(contract.title, contract.sections);
      const attachmentId = await uploadAttachment(req, item.key, contract.fileName, DOCX_TYPE, bytes);
      const back = await downloadAttachment(req, attachmentId);
      if (sha256Hex(back) !== sha256Hex(bytes)) throw new Error(`the file attached to ${item.key} came back different from the one sent`);

      await save(`Creating work related to ${item.key}`);
      for (const related of contract.related) {
        const type = related.kind === 'incident' ? incident : task;
        const created = await createAssigned(
          req,
          {
            project: { id: projectId },
            issuetype: { id: type.id },
            summary: related.summary,
            description: doc(related.description, 'Fictional sample work loaded by Covenant.'),
            labels: related.kind === 'incident' ? [LABEL, 'incident'] : [LABEL],
          },
          accountId,
        );
        await linkIssues(req, created.key, item.key);
        status.related.push(created.key);
      }

      await save(`Queuing extraction of ${item.key}`);
      const extraction = await startExtraction(item.id, attachmentId, accountId, req);
      status.contracts.push({ key: item.key, summary: contract.workItemSummary, extraction: extraction.outcome });
      await save(`Loaded ${item.key}`);
    }
    status.status = 'done';
    status.finishedAtMs = Date.now();
    await save('Done');
    console.log(`sample workspace done project=${projectId} contracts=${status.contracts.length} related=${status.related.length} ms=${Date.now() - started}`);
  } catch (error) {
    console.error(`sample workspace failed project=${projectId} error=${loggableError(error)} ms=${Date.now() - started}`);
    status.status = 'failed';
    status.finishedAtMs = Date.now();
    status.error = readableError(error, 'Loading the sample workspace failed');
    await save('Failed').catch(() => undefined);
  }
}
