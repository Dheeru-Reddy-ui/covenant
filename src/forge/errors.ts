import { UnsupportedDocumentError } from '../parse/document';
import { JiraError } from './jira';

/** An error whose message is written for the person using the panel. It never contains contract text. */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}

/** A message safe to show a reviewer, for any error. */
export function readableError(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError || error instanceof JiraError) return error.message;
  if (error instanceof UnsupportedDocumentError) return 'Covenant reads text PDFs and Word (.docx) files, and could not read this one.';
  const name = error instanceof Error ? error.name : 'Error';
  return `${fallback} (${name})`;
}

/** What may go in a log line about an error: its name and, for Jira, the status. Never its message, which could quote input. */
export function loggableError(error: unknown): string {
  if (error instanceof JiraError) return `JiraError status=${error.status} fields=${error.fields.join(',')}`;
  return error instanceof Error ? error.name : typeof error;
}
