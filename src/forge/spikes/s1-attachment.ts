import api, { route } from '@forge/api';
import { type DocumentFingerprint, fingerprint, parseDocument, sniffKind } from '../../parse/document';

/**
 * S1: download every PDF and DOCX attached to a work item, as binary, inside a
 * Forge function, and extract the text.
 *
 * Pass: for each file, bytesSha256 equals the SHA-256 of the file on disk and
 * textSha256 equals what `npm run spike:local -- <file>` prints for it.
 * Fallback if it fails: accept DOCX and pasted text only.
 *
 * Runs as the app, because the real extraction will run in a queue consumer
 * where there is no signed-in user.
 */

interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface AttachmentSpikeFile {
  attachmentId: string;
  /** Extension only. The file name can identify a counterparty, so it is not returned or logged. */
  extension: string;
  reportedSize: number;
  status: 'parsed' | 'skipped' | 'failed';
  note?: string;
  downloadMs?: number;
  parseMs?: number;
  fingerprint?: DocumentFingerprint;
}

export interface AttachmentSpikeResult {
  issueKey: string;
  attachmentCount: number;
  files: AttachmentSpikeFile[];
}

const MAX_FILES = 5;
const MAX_BYTES = 15 * 1024 * 1024;

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

export async function runAttachmentSpike(issueKey: string): Promise<AttachmentSpikeResult> {
  const issueResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment`, {
    headers: { Accept: 'application/json' },
  });
  if (!issueResponse.ok) throw new Error(`reading the work item failed with HTTP ${issueResponse.status}`);
  const issue = (await issueResponse.json()) as { fields?: { attachment?: JiraAttachment[] } };
  const attachments = issue.fields?.attachment ?? [];

  const files: AttachmentSpikeFile[] = [];
  for (const attachment of attachments.slice(0, MAX_FILES)) {
    const base = {
      attachmentId: attachment.id,
      extension: extensionOf(attachment.filename),
      reportedSize: attachment.size,
    };
    if (!['pdf', 'docx'].includes(base.extension)) {
      files.push({ ...base, status: 'skipped', note: 'not a PDF or DOCX' });
      continue;
    }
    if (attachment.size > MAX_BYTES) {
      files.push({ ...base, status: 'skipped', note: 'larger than the 15 MB spike limit' });
      continue;
    }

    try {
      const downloadStarted = Date.now();
      // redirect=false makes Jira return the bytes itself instead of a 303 to the media service.
      const contentResponse = await api
        .asApp()
        .requestJira(route`/rest/api/3/attachment/content/${attachment.id}?redirect=false`);
      if (!contentResponse.ok) {
        files.push({ ...base, status: 'failed', note: `download failed with HTTP ${contentResponse.status}` });
        continue;
      }
      const bytes = new Uint8Array(await contentResponse.arrayBuffer());
      const downloadMs = Date.now() - downloadStarted;

      if (sniffKind(bytes) === null) {
        files.push({
          ...base,
          status: 'failed',
          downloadMs,
          note: `downloaded ${bytes.byteLength} bytes that do not start like a PDF or DOCX: the binary was probably corrupted in transit`,
        });
        continue;
      }

      const parseStarted = Date.now();
      const parsed = await parseDocument(bytes);
      files.push({
        ...base,
        status: 'parsed',
        downloadMs,
        parseMs: Date.now() - parseStarted,
        fingerprint: fingerprint(bytes, parsed),
      });
    } catch (error) {
      files.push({ ...base, status: 'failed', note: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' });
    }
  }

  return { issueKey, attachmentCount: attachments.length, files };
}
