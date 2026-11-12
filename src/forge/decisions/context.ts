import { type Evidence, rankOwners } from '../../../packages/core/src';
import type { ContextView } from '../../shared/panel';
import * as repo from '../db/repo';
import { UserFacingError, loggableError } from '../errors';
import { GraphError, graphPages } from '../graph/client';
import { type FoundIssue, JiraError, asUser, searchIssues } from '../jira';
import { loadBundle } from './actions';

/**
 * Context for a decision brief: the work linked to the contract, incidents,
 * goals, the teams on its space, and owner suggestions with their evidence.
 *
 * Loaded only when a person opens it, as that person, and cached per contract
 * and per person because every source filters by the reader's permissions.
 * Jira supplies linked work and incidents (Teamwork Graph has no curated query
 * for them); Teamwork Graph supplies goals, teams and commenters. A section
 * that fails is reported as a problem, never shown as empty.
 */

const TTL_MS = 60 * 60 * 1000;
const COMMENT_ITEMS = 5;
const MAX_TEAMS = 3;
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const GOALS = `
query OP($id: ID!, $first: Int, $after: String) {
  jiraWorkItemGoals(id: $id, first: $first, after: $after) {
    edges { node { ... on AtlassianGoal { name key url dueDateEndedAt archived owner { name ... on AtlassianUser { accountId } } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const TEAMS = `
query OP($spaceAri: ID!, $first: Int, $after: String) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: $first, after: $after) {
    edges { node { ... on AtlassianTeam { id displayName profileUrl } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const MEMBERS = `
query OP($teamAri: ID!, $first: Int, $after: String) {
  atlassianTeamMembers(teamAri: $teamAri, first: $first, after: $after) {
    edges { node { ... on AtlassianUser { accountId name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COMMENTS = `
query OP($id: ID!, $since: String!, $first: Int, $after: String) {
  jiraWorkItemComments(id: $id, since: $since, first: $first, after: $after) {
    edges { node { ... on JiraWorkItemComment { createdAt deleted author { name ... on AtlassianUser { accountId } } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface GoalNode {
  name?: string | null;
  key?: string | null;
  url?: string | null;
  dueDateEndedAt?: string | null;
  archived?: boolean | null;
  owner?: { name?: string | null; accountId?: string } | null;
}
interface TeamNode {
  id?: string;
  displayName?: string | null;
  profileUrl?: string | null;
}
interface MemberNode {
  accountId?: string;
  name?: string | null;
}
interface CommentNode {
  createdAt?: string | null;
  deleted?: boolean | null;
  author?: { name?: string | null; accountId?: string } | null;
}

const day = (dateTime: string | null | undefined): string | null => (dateTime ? dateTime.slice(0, 10) : null);
const isIncident = (i: FoundIssue): boolean => /incident|bug|problem/i.test(i.issueType) || i.labels.some((l) => l.toLowerCase() === 'incident');
const graphProblem = (what: string, error: unknown): string =>
  error instanceof GraphError
    ? `Teamwork Graph could not load ${what}: ${error.message}${error.graphErrors.length > 0 ? ` (${error.graphErrors.slice(0, 2).join('; ')})` : ''}.`
    : `Teamwork Graph could not load ${what}.`;

export async function loadContext(issueId: string, contractId: string, accountId: string, cloudId: string, refresh: boolean): Promise<ContextView> {
  const { contract } = await loadBundle(issueId, contractId);
  if (!refresh) {
    const cached = await repo.getCachedContext(contract.id, accountId);
    if (cached !== null && Date.now() - cached.fetchedAtMs < TTL_MS) return { ...(cached.payload as ContextView), cached: true };
  }
  if (!KEY.test(contract.issueKey)) throw new UserFacingError('This contract is on a work item whose key Covenant cannot search for.');

  const started = Date.now();
  const problems: string[] = [];
  const evidence: Evidence[] = [];
  const apps = new Set<string>();
  const ari = (id: string) => `ari:cloud:jira:${cloudId}:issue/${id}`;

  // Jira: work linked to the contract, and the children Covenant created for it.
  let linked: FoundIssue[] = [];
  let children: FoundIssue[] = [];
  try {
    [linked, children] = await Promise.all([
      searchIssues(asUser(), `issue in linkedIssues("${contract.issueKey}") ORDER BY updated DESC`, 30),
      searchIssues(asUser(), `parent = ${contract.issueKey} ORDER BY updated DESC`, 50),
    ]);
  } catch (error) {
    problems.push(error instanceof JiraError ? `Jira could not list the linked work: ${error.message}.` : 'Jira could not list the linked work.');
  }
  for (const issue of [...linked, ...children]) {
    const label = `${issue.key} ${issue.summary}`.slice(0, 80);
    for (const [person, kind] of [
      [issue.assignee, 'assignee'],
      [issue.reporter, 'reporter'],
    ] as const) {
      if (person === null) continue;
      if (person.accountType === 'app') {
        apps.add(person.accountId);
        continue;
      }
      evidence.push({ accountId: person.accountId, name: person.displayName, kind, itemKey: issue.key, itemLabel: label, at: day(issue.updated) });
    }
  }

  // Teamwork Graph: goals on the contract's work item.
  const goals: ContextView['goals'] = [];
  try {
    const page = await graphPages<GoalNode>('workItemGoals', GOALS, 'jiraWorkItemGoals', { id: ari(contract.issueId) }, 2);
    for (const g of page.nodes) {
      if (g.archived) continue;
      goals.push({ name: g.name ?? 'Untitled goal', key: g.key ?? null, url: g.url ?? null, due: day(g.dueDateEndedAt), owner: g.owner?.name ?? null });
      if (g.owner?.accountId) {
        evidence.push({ accountId: g.owner.accountId, name: g.owner.name ?? null, kind: 'goal_owner', itemKey: g.key ?? g.name ?? null, itemLabel: `${g.key ? `${g.key} ` : ''}${g.name ?? ''}`.trim(), at: null });
      }
    }
  } catch (error) {
    problems.push(graphProblem('goals', error));
  }

  // Teamwork Graph: teams linked to the contract's space, and their members.
  const teams: ContextView['teams'] = [];
  try {
    const page = await graphPages<TeamNode>('spaceTeams', TEAMS, 'atlassianTeamsBySpace', { spaceAri: `ari:cloud:jira:${cloudId}:project/${contract.projectId}` }, 1);
    for (const team of page.nodes.slice(0, MAX_TEAMS)) {
      if (!team.id) continue;
      const name = team.displayName ?? 'A team';
      const members = await graphPages<MemberNode>('teamMembers', MEMBERS, 'atlassianTeamMembers', { teamAri: team.id }, 2);
      teams.push({ name, url: team.profileUrl ?? null, members: members.nodes.length });
      for (const m of members.nodes) {
        if (m.accountId) evidence.push({ accountId: m.accountId, name: m.name ?? null, kind: 'team_member', itemKey: null, itemLabel: name, at: null });
      }
    }
  } catch (error) {
    problems.push(graphProblem('the teams on this space', error));
  }

  // Teamwork Graph: who has been commenting on the linked work.
  try {
    for (const issue of linked.slice(0, COMMENT_ITEMS)) {
      const page = await graphPages<CommentNode>('workItemComments', COMMENTS, 'jiraWorkItemComments', { id: ari(issue.id), since: 'P180D' }, 1);
      for (const c of page.nodes) {
        if (c.deleted || !c.author?.accountId) continue;
        evidence.push({
          accountId: c.author.accountId,
          name: c.author.name ?? null,
          kind: 'commenter',
          itemKey: issue.key,
          itemLabel: `${issue.key} ${issue.summary}`.slice(0, 80),
          at: day(c.createdAt),
        });
      }
    }
  } catch (error) {
    problems.push(graphProblem('comments on the linked work', error));
  }

  const view: ContextView = {
    fetchedAtMs: Date.now(),
    cached: false,
    related: [...linked, ...children].map((i) => ({
      key: i.key,
      summary: i.summary,
      type: i.issueType,
      status: i.status,
      assignee: i.assignee?.displayName ?? null,
      incident: isIncident(i),
      viaCovenant: children.includes(i),
    })),
    goals,
    teams,
    owners: rankOwners(evidence, { exclude: [...apps], limit: 5 }).map((o) => ({ accountId: o.accountId, name: o.name, score: o.score, evidence: o.evidence })),
    problems,
  };
  await repo.putCachedContext(contract.id, accountId, view, view.fetchedAtMs).catch((e: unknown) => {
    console.error(`context cache write failed contract=${contract.id} error=${loggableError(e)}`);
  });
  console.log(
    `context loaded contract=${contract.id} linked=${linked.length} children=${children.length} goals=${goals.length} teams=${teams.length} ` +
      `owners=${view.owners.length} problems=${problems.length} ms=${Date.now() - started}`,
  );
  return view;
}
