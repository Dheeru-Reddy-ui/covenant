import { locateQuote, sectionAt } from '../../../packages/core/src';
import { UnsupportedDocumentError, parseDocument, sha256Hex } from '../../parse/document';
import * as repo from '../db/repo';
import { loggableError } from '../errors';
import { JiraError, asApp, downloadAttachment } from '../jira';

/**
 * Finds the clause number for quotes extracted before Covenant looked for
 * them. It reads the contract file again with code only (no model call),
 * finds each stored quote in it, and records the clause around it. A file
 * that is gone or has changed gets "none found", so it is not retried forever;
 * any other failure is left for the next run.
 */

const MAX_CONTRACTS = 5;
const MAX_CLAUSES = 200;

export interface SectionBackfill {
  contracts: number;
  clauses: number;
  found: number;
  failed: number;
}

export async function backfillClauseSections(): Promise<SectionBackfill> {
  const result: SectionBackfill = { contracts: 0, clauses: 0, found: 0, failed: 0 };
  const missing = await repo.listClausesWithoutSection(MAX_CLAUSES);
  const byContract = new Map<string, repo.ClauseRow[]>();
  for (const clause of missing) byContract.set(clause.contractId, [...(byContract.get(clause.contractId) ?? []), clause]);

  for (const [contractId, clauses] of [...byContract].slice(0, MAX_CONTRACTS)) {
    const now = Date.now();
    const noneFor = async () => {
      for (const c of clauses) await repo.saveClauseSection(c.id, c.runId, null, now);
      result.clauses += clauses.length;
    };
    try {
      const contract = await repo.getContract(contractId);
      if (contract === null) {
        await noneFor();
        continue;
      }
      const bytes = await downloadAttachment(asApp(), contract.attachmentId);
      if (sha256Hex(bytes) !== contract.sha256) {
        await noneFor();
        continue;
      }
      const { source } = await parseDocument(bytes);
      for (const c of clauses) {
        const located = locateQuote(c.quote, source, c.page);
        const section = located.status === 'verified' ? sectionAt(source, located.match) : null;
        await repo.saveClauseSection(c.id, c.runId, section, now);
        result.clauses += 1;
        if (section !== null) result.found += 1;
      }
      result.contracts += 1;
    } catch (error) {
      const gone = (error instanceof JiraError && (error.status === 403 || error.status === 404)) || error instanceof UnsupportedDocumentError;
      if (gone) await noneFor();
      else result.failed += 1;
      console.error(`sections backfill contract=${contractId} error=${loggableError(error)}`);
    }
  }
  if (missing.length > 0) {
    console.log(`sections backfill contracts=${result.contracts} clauses=${result.clauses} found=${result.found} failed=${result.failed}`);
  }
  return result;
}
