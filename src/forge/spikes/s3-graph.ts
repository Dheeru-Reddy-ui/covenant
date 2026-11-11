import api from '@forge/api';

/**
 * S3: run one curated Teamwork Graph query, as the signed-in user, that returns
 * the work items assigned to them.
 *
 * Pass: no errors, and `rows` matches the number of work items assigned to you.
 * Fallback if it fails: use Jira search for owner hints and withdraw the
 * Teamwork Graph bonus entry.
 *
 * NOT VERIFIED AGAINST OFFICIAL DOCS: Atlassian's pages confirm that curated
 * queries exist, need no registration and page with first/after, and they name
 * atlassianUserAssignedJiraWorkItems as an example. The field's arguments and
 * node shape below come from a developer's write-up, not a reference page.
 * If the API rejects the query, the errors it returns are the spike's result.
 *
 * Rules this client follows, each from a documented or reported failure:
 * - as the signed-in user only (asApp is not offered by the SDK);
 * - the operation name is `<prefix>_<name>`, prefix 3+ characters, name 4+;
 * - HTTP 200 is not success: the body must have data and no errors;
 * - page until hasNextPage is false, even after a short page;
 * - an error is an error, never "no data".
 */

const OPERATION_PREFIX = 'covenant';
const PAGE_SIZE = 25;
const MAX_PAGES = 20;

const ASSIGNED_WORK_ITEMS = `
query OP($userId: ID!, $first: Int, $after: String) {
  atlassianUserAssignedJiraWorkItems(userId: $userId, first: $first, after: $after) {
    edges {
      node {
        ... on JiraWorkItem {
          key
          summary
          status { name }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface GraphErrorBody {
  message?: string;
  extensions?: { classification?: string; errorType?: string; statusCode?: number };
}

interface AssignedPage {
  data?: {
    atlassianUserAssignedJiraWorkItems?: {
      edges?: Array<{ node?: { key?: string } | null } | null> | null;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    } | null;
  } | null;
  errors?: GraphErrorBody[];
}

export class TeamworkGraphError extends Error {
  override name = 'TeamworkGraphError';
  constructor(
    message: string,
    readonly status: number,
    readonly graphErrors: string[],
  ) {
    super(message);
  }
}

async function graphRequest<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const operationName = `${OPERATION_PREFIX}_${operation}`;
  const response = await api.asUser().requestTeamworkGraph(query.replace('query OP', `query ${operationName}`), variables, operationName);
  const text = await response.text();

  let body: { data?: unknown; errors?: GraphErrorBody[] } | null = null;
  try {
    body = JSON.parse(text) as { data?: unknown; errors?: GraphErrorBody[] };
  } catch {
    body = null;
  }
  const graphErrors = (body?.errors ?? []).map((e) => e.message ?? e.extensions?.errorType ?? 'unnamed error');

  if (!response.ok) throw new TeamworkGraphError(`Teamwork Graph returned HTTP ${response.status}`, response.status, graphErrors);
  if (body === null) throw new TeamworkGraphError('Teamwork Graph returned a body that is not JSON', response.status, []);
  if (graphErrors.length > 0) throw new TeamworkGraphError('Teamwork Graph returned errors with HTTP 200', response.status, graphErrors);
  if (body.data === undefined || body.data === null) throw new TeamworkGraphError('Teamwork Graph returned no data', response.status, []);
  return body as T;
}

export interface GraphSpikeResult {
  operation: string;
  pages: number;
  rows: number;
  /** Work item keys only, to compare against "assigned to me" in Jira. */
  sampleKeys: string[];
  stoppedAtPageCap: boolean;
  ms: number;
}

export async function runGraphSpike(accountId: string): Promise<GraphSpikeResult> {
  const started = Date.now();
  const userId = `ari:cloud:identity::user/${accountId}`;
  const keys: string[] = [];
  let after: string | null = null;
  let pages = 0;
  let hasNextPage = true;

  while (hasNextPage && pages < MAX_PAGES) {
    const page: AssignedPage = await graphRequest<AssignedPage>('assignedWorkItems', ASSIGNED_WORK_ITEMS, {
      userId,
      first: PAGE_SIZE,
      after,
    });
    const connection = page.data?.atlassianUserAssignedJiraWorkItems;
    if (!connection) throw new TeamworkGraphError('the curated field came back null', 200, []);
    pages += 1;
    for (const edge of connection.edges ?? []) {
      if (edge?.node?.key) keys.push(edge.node.key);
    }
    hasNextPage = connection.pageInfo?.hasNextPage === true;
    after = connection.pageInfo?.endCursor ?? null;
    if (hasNextPage && after === null) throw new TeamworkGraphError('hasNextPage is true but there is no cursor', 200, []);
  }

  return {
    operation: `${OPERATION_PREFIX}_assignedWorkItems`,
    pages,
    rows: keys.length,
    sampleKeys: keys.slice(0, 5),
    stoppedAtPageCap: hasNextPage,
    ms: Date.now() - started,
  };
}
