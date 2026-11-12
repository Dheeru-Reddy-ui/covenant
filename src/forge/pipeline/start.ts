import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import { EXTRACTOR_VERSION, PRODUCTION_MODEL, SCHEMA_VERSION } from '../../../packages/core/src';
import { sha256Hex, sniffKind } from '../../parse/document';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { UserFacingError, loggableError } from '../errors';
import { type Requester, asUser, downloadAttachment, getIssue } from '../jira';

/**
 * The Extract button. Runs in a UI resolver (25 s), so it only identifies the
 * file and queues the work; the worker does the reading.
 *
 * A run is keyed on the work item, the attachment's SHA-256 and the extractor
 * version. Clicking Extract again finds the same run and queues nothing,
 * unless that run failed or died, in which case the same run is retried.
 */

export const EXTRACTION_QUEUE = 'covenant-extraction';
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** A run still queued or running after this long was lost: the worker's limit is 900 s. */
export const STALE_RUN_MS = 16 * 60 * 1000;

const queue = new Queue({ key: EXTRACTION_QUEUE });

export interface StartResult {
  contractId: string;
  runId: string;
  outcome: 'queued' | 'requeued' | 'existing';
  status: repo.RunStatus;
}

/** `req` is the signed-in user for the Extract button, and the app when the sample workspace queues its contracts. */
export async function startExtraction(issueId: string, attachmentId: string, accountId: string, req: Requester = asUser()): Promise<StartResult> {
  const started = Date.now();
  await ensureSchema();
  const issue = await getIssue(req, issueId);
  const attachment = issue.attachments.find((a) => a.id === attachmentId);
  if (attachment === undefined) throw new UserFacingError('That file is no longer attached to this work item.');
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new UserFacingError('That file is larger than 15 MB. Covenant reads contracts of up to about 40 pages.');
  }

  const bytes = await downloadAttachment(req, attachment.id);
  const kind = sniffKind(bytes);
  if (kind === null) throw new UserFacingError('Covenant reads text PDFs and Word (.docx) files. That file is neither.');
  const sha256 = sha256Hex(bytes);
  const now = Date.now();

  await repo.insertContractIfNew({
    id: randomUUID(),
    issueId: issue.id,
    issueKey: issue.key,
    projectId: issue.projectId,
    attachmentId: attachment.id,
    sha256,
    fileName: attachment.filename.slice(0, 255),
    fileKind: kind,
    byteLength: bytes.byteLength,
    termIndex: 0,
    createdBy: accountId,
    createdAtMs: now,
  });
  const contract = await repo.findContract(issue.id, sha256);
  if (contract === null) throw new Error('contract row missing after insert');
  // The same bytes may have been attached again under a new id; read the one that is there now.
  if (contract.attachmentId !== attachment.id) await repo.setContractAttachment(contract.id, attachment.id);

  const created = await repo.insertRunIfNew({
    id: randomUUID(),
    contractId: contract.id,
    extractorVersion: EXTRACTOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    model: PRODUCTION_MODEL,
    requestedBy: accountId,
    nowMs: now,
  });
  const run = await repo.findRun(contract.id, EXTRACTOR_VERSION);
  if (run === null) throw new Error('run row missing after insert');

  let outcome: StartResult['outcome'] = 'existing';
  if (created) outcome = 'queued';
  else if (await repo.requeueRun(run.id, accountId, now, now - STALE_RUN_MS)) outcome = 'requeued';
  if (outcome !== 'existing') await push(run.id);

  console.log(
    `extract start issue=${issue.id} contract=${contract.id} run=${run.id} outcome=${outcome} kind=${kind} bytes=${bytes.byteLength} ms=${Date.now() - started}`,
  );
  return { contractId: contract.id, runId: run.id, outcome, status: outcome === 'existing' ? run.status : 'queued' };
}

async function push(runId: string): Promise<void> {
  try {
    const { jobId } = await queue.push({ body: { runId } });
    await repo.setRunJob(runId, jobId);
  } catch (error) {
    console.error(`extract queue push failed run=${runId} error=${loggableError(error)}`);
    await repo.failRun(runId, 'queue_failed', 'Covenant could not queue the extraction. Click Extract to try again.', {}, Date.now());
    throw new UserFacingError('Covenant could not queue the extraction. Click Extract to try again.');
  }
}
