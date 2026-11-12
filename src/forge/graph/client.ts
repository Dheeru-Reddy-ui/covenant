import api from '@forge/api';

/**
 * Teamwork Graph client (Preview). Called only from UI resolvers, as the
 * signed-in user: never from the daily trigger or a queue worker.
 *
 * Rules, each from a documented or reported failure:
 * - operation names are `covenant_<name>`, the name at least 4 characters;
 * - HTTP 200 is not success: the body must have data and no errors;
 * - page with first/after (at most 25) until hasNextPage is false, even after a short page;
 * - an error is an error, never "no data";
 * - a rate limit is retried with a short backoff that fits inside a resolver's 25 seconds.
 */

const PREFIX = 'covenant';
export const PAGE_SIZE = 25;
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 4000;

export class GraphError extends Error {
  override name = 'GraphError';
  constructor(
    message: string,
    readonly status: number,
    readonly graphErrors: string[],
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

interface GraphErrorBody {
  message?: string;
  extensions?: { classification?: string; errorType?: string; statusCode?: number };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimit = (e: GraphErrorBody): boolean =>
  e.extensions?.statusCode === 429 || /rate.?limit|throttl/i.test(`${e.extensions?.classification ?? ''} ${e.extensions?.errorType ?? ''} ${e.message ?? ''}`);

/** One GraphQL request, with backoff on rate limits. */
export async function graphQuery<T>(name: string, query: string, variables: Record<string, unknown>): Promise<T> {
  if (!/^[A-Za-z0-9]{4,}$/.test(name)) throw new Error(`graph operation name "${name}" must be 4+ letters or digits`);
  const operationName = `${PREFIX}_${name}`;
  const named = query.replace(/^\s*query\s+OP\b/, `query ${operationName}`);

  for (let attempt = 1; ; attempt += 1) {
    const response = await api.asUser().requestTeamworkGraph(named, variables, operationName);
    const text = await response.text();
    let body: { data?: unknown; errors?: GraphErrorBody[] } | null = null;
    try {
      body = JSON.parse(text) as { data?: unknown; errors?: GraphErrorBody[] };
    } catch {
      body = null;
    }
    const errors = body?.errors ?? [];
    const limited = response.status === 429 || response.status === 503 || errors.some(isRateLimit);
    if (limited && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1) + Math.random() * 250;
      await sleep(Math.min(wait, MAX_WAIT_MS));
      continue;
    }
    const messages = errors.map((e) => e.message ?? e.extensions?.errorType ?? 'unnamed error');
    if (limited) throw new GraphError('Teamwork Graph is rate limiting requests', response.status, messages, true);
    if (!response.ok) throw new GraphError(`Teamwork Graph returned HTTP ${response.status}`, response.status, messages);
    if (body === null) throw new GraphError('Teamwork Graph returned a body that is not JSON', response.status, []);
    if (messages.length > 0) throw new GraphError('Teamwork Graph returned errors', response.status, messages);
    if (body.data === undefined || body.data === null) throw new GraphError('Teamwork Graph returned no data', response.status, []);
    return body.data as T;
  }
}

interface Connection<N> {
  edges?: Array<{ node?: N | null } | null> | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

export interface Paged<N> {
  nodes: N[];
  pages: number;
  /** True when maxPages stopped the paging before hasNextPage was false. */
  truncated: boolean;
}

/**
 * Pages a curated field to the end. `query` must take $first and $after and
 * return the connection at `data[field]`. Null nodes are dropped and counted
 * as not readable, which is how missing permissions show up.
 */
export async function graphPages<N>(
  name: string,
  query: string,
  field: string,
  variables: Record<string, unknown>,
  maxPages = 8,
): Promise<Paged<N>> {
  const nodes: N[] = [];
  let after: string | null = null;
  let pages = 0;
  let hasNextPage = true;
  while (hasNextPage && pages < maxPages) {
    const data: Record<string, Connection<N> | null | undefined> = await graphQuery(name, query, { ...variables, first: PAGE_SIZE, after });
    const connection = data[field];
    if (connection === null || connection === undefined) throw new GraphError(`the curated field ${field} came back null`, 200, []);
    pages += 1;
    for (const edge of connection.edges ?? []) if (edge?.node) nodes.push(edge.node);
    hasNextPage = connection.pageInfo?.hasNextPage === true;
    after = connection.pageInfo?.endCursor ?? null;
    if (hasNextPage && after === null) throw new GraphError('hasNextPage is true but there is no cursor', 200, []);
  }
  return { nodes, pages, truncated: hasNextPage };
}

export const userAri = (accountId: string): string => `ari:cloud:identity::user/${accountId}`;

const ASSIGNED = `
query OP($userId: ID!, $first: Int, $after: String) {
  atlassianUserAssignedJiraWorkItems(userId: $userId, first: $first, after: $after) {
    edges { node { ... on JiraWorkItem { key } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** The preflight probe: one page of the caller's assigned work items. */
export async function probeGraph(accountId: string): Promise<{ rows: number; hasMore: boolean }> {
  const page = await graphPages<{ key?: string }>('preflightProbe', ASSIGNED, 'atlassianUserAssignedJiraWorkItems', { userId: userAri(accountId) }, 1);
  return { rows: page.nodes.length, hasMore: page.truncated };
}
