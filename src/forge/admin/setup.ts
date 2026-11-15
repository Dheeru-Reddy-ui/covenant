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
const PROJECT_NAME = 'Contracts';
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
  if (project === null) {
    try {
      project = await createProject(req, {
        key: SETUP_PROJECT_KEY,
        name: PROJECT_NAME,
        description: 'Contracts tracked by Covenant: one work item per contract, with the contract file attached.',
        leadAccountId: accountId,
      });
      projectCreated = true;
    } catch (error) {
      if (error instanceof JiraError && (error.status === 401 || error.status === 403)) throw new UserFacingError(NEEDS_PERMISSION);
      throw error;
    }
  }

  // 2. The work type. A failure here is not fatal: the sample contracts fall back to Task, and the note says so.
  let issueTypeId: string | null = null;
  let typeCreated = false;
  try {
    const existing = (await listIssueTypes(req)).find((t) => t.name === CONTRACT_TYPE_NAME && !t.subtask && t.scope === undefined);
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

  const changed = projectCreated || typeCreated || sampleState === 'started';
  console.log(`setup project=${project.id} projectCreated=${projectCreated} typeCreated=${typeCreated} sample=${sampleState} changed=${changed}`);
  return {
    project: { key: project.key, name: project.name, created: projectCreated },
    workType: issueTypeId === null ? null : { name: CONTRACT_TYPE_NAME, created: typeCreated },
    sample: sampleState,
    changed,
    notes,
  };
}
