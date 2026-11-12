import { list } from '@forge/llm';
import { migrationRunner } from '@forge/sql';
import { FALLBACK_MODEL, PRODUCTION_MODEL } from '../../../packages/core/src';
import type { PreflightCheck } from '../../shared/admin';
import * as repo from '../db/repo';
import { ensureSchema } from '../db/schema';
import { loggableError } from '../errors';
import { GraphError, probeGraph } from '../graph/client';
import { asApp, asUser, jiraStatus, listCreatableProjects } from '../jira';
import type { DailySummary } from '../jobs/daily';
import { DAILY_LAST_RUN, getJson } from '../settings';

/**
 * The admin preflight. Each check says plainly whether it passed and what to
 * do if not. Things the app cannot see from inside Forge are reported as
 * checks to do by hand, with the steps.
 */

export const APP_ID = '0eb73671-31a0-4410-ae90-4d8ba0607caa';
export const MCP_ENDPOINT = `https://mcp.atlassian.com/forge/${APP_ID}`;

const DAY_MS = 24 * 60 * 60 * 1000;

async function check(key: string, title: string, run: () => Promise<Omit<PreflightCheck, 'key' | 'title'>>): Promise<PreflightCheck> {
  try {
    return { key, title, ...(await run()) };
  } catch (error) {
    console.error(`preflight ${key} failed error=${loggableError(error)}`);
    const message = error instanceof Error ? error.message : String(error);
    return { key, title, status: 'fail', detail: message.slice(0, 400), fix: null };
  }
}

export async function runPreflight(accountId: string): Promise<PreflightCheck[]> {
  return Promise.all([
    check('database', 'Database (Forge SQL)', async () => {
      await ensureSchema();
      const applied = await migrationRunner.list();
      const contracts = await repo.listAllContracts();
      return {
        status: 'pass',
        detail: `${applied.length} migrations applied. ${contracts.length} contract${contracts.length === 1 ? '' : 's'} stored.`,
        fix: null,
      };
    }),

    check('model', 'AI model (Forge LLMs)', async () => {
      const { models } = await list();
      const production = models.find((m) => m.model === PRODUCTION_MODEL);
      const fallback = models.find((m) => m.model === FALLBACK_MODEL);
      if (production?.status === 'active') return { status: 'pass', detail: `${PRODUCTION_MODEL} is available.`, fix: null };
      if (production !== undefined) {
        return {
          status: 'warn',
          detail: `${PRODUCTION_MODEL} is marked ${production.status}. It still answers for now.`,
          fix: fallback ? `${FALLBACK_MODEL} is available as the fallback.` : 'Ask the developer to move to a current model.',
        };
      }
      return {
        status: 'fail',
        detail: `${PRODUCTION_MODEL} is not offered on this site.`,
        fix:
          'In Atlassian Administration, open Apps, then Sites, this site, Connected apps, Covenant, and check that "Access to Atlassian-hosted AI models" is on.',
      };
    }),

    check('jira', 'Jira access', async () => {
      const status = await jiraStatus(asApp());
      if (status !== 200) return { status: 'fail', detail: `Covenant could not reach Jira as the app (HTTP ${status}).`, fix: null };
      const projects = await listCreatableProjects(asUser());
      if (projects.length === 0) {
        return {
          status: 'warn',
          detail: 'Jira answers, but you cannot create work items in any project.',
          fix: 'Create a project (any template) before loading the sample workspace.',
        };
      }
      return { status: 'pass', detail: `Jira answers. You can create work items in ${projects.length} project${projects.length === 1 ? '' : 's'}.`, fix: null };
    }),

    check('graph', 'Teamwork Graph', async () => {
      try {
        const probe = await probeGraph(accountId);
        return {
          status: 'pass',
          detail: `A curated query ran as you and returned ${probe.rows}${probe.hasMore ? '+' : ''} assigned work item${probe.rows === 1 ? '' : 's'}.`,
          fix: null,
        };
      } catch (error) {
        if (!(error instanceof GraphError)) throw error;
        return {
          status: 'warn',
          detail: `${error.message}${error.graphErrors.length > 0 ? `: ${error.graphErrors.slice(0, 2).join('; ')}` : ''}.`,
          fix: 'Decision briefs still work without graph context; they say when it is missing. Teamwork Graph is in Preview, so try again later.',
        };
      }
    }),

    check('daily', 'Daily decision check', async () => {
      const last = await getJson<DailySummary>(DAILY_LAST_RUN);
      if (last === null) {
        return {
          status: 'warn',
          detail: 'The daily check has not run yet. Forge starts it within a day of installing.',
          fix: 'Use "Run the daily check now" below to run it straight away.',
        };
      }
      const age = Date.now() - last.atMs;
      const when = new Date(last.atMs).toISOString().replace('T', ' ').slice(0, 16);
      const detail = `Last ran ${when} UTC (${last.source}): ${last.contracts} contracts checked, ${last.due} with a decision due, ${last.opened.length} decision items opened, ${last.failed} failed.`;
      if (last.failed > 0) return { status: 'warn', detail, fix: 'Check that the app can create work items in the contracts\' projects.' };
      if (age > DAY_MS + 2 * 60 * 60 * 1000 && last.source === 'schedule') return { status: 'warn', detail, fix: 'The scheduled run is late. It should run once a day.' };
      return { status: 'pass', detail, fix: null };
    }),

    check('mcp', 'MCP server exposure', async () => ({
      status: 'manual',
      detail: `Covenant cannot see from inside the app whether an admin has exposed its tools. Its MCP endpoint is ${MCP_ENDPOINT}.`,
      fix: 'In Atlassian Administration, open Apps, then Sites, this site, Connected apps, Covenant, then TOOLS, and click Enable tools. Reload and check it says Enabled.',
    })),

    check('rovo', 'Rovo', async () => ({
      status: 'manual',
      detail: 'Covenant cannot see from inside the app whether Rovo is on for this site.',
      fix: 'If Rovo is on, its chat button shows in the Jira top bar. Rovo is optional: the panel, register and decisions work without it.',
    })),
  ]);
}
