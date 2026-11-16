import type { SampleStatus, SetupResult } from '../../shared/admin';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError, readableError } from '../errors';
import { JiraError, addIssueTypeToProject, asUser, createIssueType, createProject, getProject, listIssueTypes } from '../jira';
import { SAMPLE_WORKSPACE, getJson, putJson } from '../settings';
import { startSampleWorkspace } from './sample';

/**
 * One-click setup for a fresh site: a "Contracts" project, a "Contract" work
 * type in it, and the sample workspace of three fictional contracts. Each step
 * first looks for what is already there, so a second click changes nothing.
 * It runs as the administrator who clicked, with their permissions.
 */

export const SETUP = 'one_click_setup';
export const SETUP_PROJECT_KEY = 'COVN';
/** Tried in order; the first is used unless the site already has a project by that name. */
const PROJECT_NAMES = ['Contracts', 'Contracts (Covenant)', 'Covenant contracts'] as const;
export const CONTRACT_TYPE_NAME = 'Contract';
const STALE_MS = 15 * 60 * 1000;

interface StoredSetup {
  projectId: string;
  projectKey: string;
  issueTypeId: string | null;
}

const NEEDS_PERMISSION =
  'One-click setup needs permission to create projects and work types, which this installation has not been given yet. ' +
  'A site admin can grant it by updating Covenant under Atlassian Administration, Connected apps. ' +
  'Until then, create a project yourself and use "Load sample workspace" below.';

export async function oneClickSetup(accountId: string): Promise<SetupResult> {
  await ensureSchema();
  const req = asUser();
  const stored = await getJson<StoredSetup>(SETUP);
  const notes: string[] = [];

  // 1. The project: the one set up before, or one with our key, or a new one.
  let project = stored ? await getProject(req, stored.projectId) : null;
  project ??= await getProject(req, SETUP_PROJECT_KEY);
  let projectCreated = false;
  // Project names are unique in Jira, and a site may already have its own "Contracts".
  for (const name of PROJECT_NAMES) {
    if (project !== null) break;
    try {
      project = await createProject(req, {
        key: SETUP_PROJECT_KEY,
        name,
        description: 'Contracts tracked by Covenant: one work item per contract, with the contract file attached.',
        leadAccountId: accountId,
      });
      projectCreated = true;
      if (name !== PROJECT_NAMES[0]) notes.push(`A project called "${PROJECT_NAMES[0]}" already exists, so the new one is called "${name}".`);
    } catch (error) {
      if (error instanceof JiraError && (error.status === 401 || error.status === 403)) throw new UserFacingError(NEEDS_PERMISSION);
      if (!(error instanceof JiraError && error.status === 400 && error.fields.includes('projectName'))) throw error;
    }
  }
  if (project === null) {
    const names = PROJECT_NAMES.map((n) => `"${n}"`);
    throw new UserFacingError(
      `This site already has projects called ${names.slice(0, -1).join(', ')} and ${names.at(-1)}, so setup could not name a new one. ` +
        'Use "Load sample workspace" below with a project of your own instead.',
    );
  }

  // 2. The work type. A failure here is not fatal: the sample contracts fall back to Task, and the note says so.
  let issueTypeId: string | null = null;
  let typeCreated = false;
  let siteTypes: Awaited<ReturnType<typeof listIssueTypes>> = [];
  try {
    siteTypes = await listIssueTypes(req);
    const existing = siteTypes.find((t) => t.name === CONTRACT_TYPE_NAME && !t.subtask && t.scope === undefined);
    const type = existing ?? (await createIssueType(req, CONTRACT_TYPE_NAME, 'A contract, with its file attached. Covenant reads the file and tracks its obligations.'));
    typeCreated = existing === undefined;
    issueTypeId = type.id;
    if (await addIssueTypeToProject(req, project.id, type.id)) typeCreated = true;
  } catch (error) {
    console.error(`setup work type failed project=${project.id} error=${loggableError(error)}`);
    issueTypeId = null;
    notes.push(`The "${CONTRACT_TYPE_NAME}" work type could not be set up (${readableError(error, 'Jira refused')}), so sample contracts use Task.`);
  }
  await putJson(SETUP, { projectId: project.id, projectKey: project.key, issueTypeId } satisfies StoredSetup, accountId);

  // 2b. The procurement template's only standard work type is "Order", so the sample's
  // reviews and incidents would be Orders. Add a company-wide Task type: the site's own,
  // or a new one, since a fresh site's only Task belongs to its first team-managed space.
  let taskAdded = false;
  try {
    const existing = siteTypes.find((t) => /^task$/i.test(t.name) && !t.subtask && t.scope === undefined);
    const task = existing ?? (await createIssueType(req, 'Task', 'A piece of work to be done.'));
    taskAdded = await addIssueTypeToProject(req, project.id, task.id);
    if (taskAdded) notes.push(`Added the Task work type to ${project.name}, for the related work in the sample workspace.`);
  } catch (error) {
    console.error(`setup task type failed project=${project.id} error=${loggableError(error)}`);
  }

  // 2c. Approved obligations, Decision due reminders and notice items are created under
  // the contract, which needs a subtask type in the project. The procurement scheme has
  // none, and a fresh site's only Subtask types belong to its team-managed spaces.
  let subtaskAdded = false;
  try {
    const existing = siteTypes.find((t) => (t.subtask === true || t.hierarchyLevel === -1) && t.scope === undefined);
    const subtask = existing ?? (await createIssueType(req, 'Subtask', 'A smaller piece of work under another work item.', -1));
    subtaskAdded = await addIssueTypeToProject(req, project.id, subtask.id);
    if (subtaskAdded) notes.push(`Added the ${subtask.name} work type to ${project.name}, so approved obligations and reminders can be created under each contract.`);
  } catch (error) {
    console.error(`setup subtask type failed project=${project.id} error=${loggableError(error)}`);
    notes.push(
      `The Subtask work type could not be added to ${project.name} (${readableError(error, 'Jira refused')}), so approving an obligation there will fail until a Jira administrator adds one.`,
    );
  }

  // 3. The sample workspace, unless it is loaded or loading already.
  const sample = await getJson<SampleStatus>(SAMPLE_WORKSPACE);
  let sampleState: SetupResult['sample'];
  if (sample?.status === 'done') {
    sampleState = 'already_loaded';
    notes.push(`The sample workspace is already loaded in ${sample.projectKey}.`);
  } else if (sample !== null && (sample.status === 'queued' || sample.status === 'running') && Date.now() - sample.startedAtMs < STALE_MS) {
    sampleState = 'loading';
  } else {
    await startSampleWorkspace(project.id, accountId, false);
    sampleState = 'started';
  }

  const changed = projectCreated || typeCreated || taskAdded || subtaskAdded || sampleState === 'started';
  console.log(
    `setup project=${project.id} projectCreated=${projectCreated} typeCreated=${typeCreated} taskAdded=${taskAdded} subtaskAdded=${subtaskAdded} sample=${sampleState} changed=${changed}`,
  );
  return {
    project: { key: project.key, name: project.name, created: projectCreated },
    workType: issueTypeId === null ? null : { name: CONTRACT_TYPE_NAME, created: typeCreated },
    sample: sampleState,
    changed,
    notes,
  };
}
