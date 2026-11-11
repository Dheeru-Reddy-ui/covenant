import api, { route } from '@forge/api';

/**
 * S4: one tool exposed through the rovo:mcp module.
 *
 * Pass: the app deploys with the rovo:mcp module, and after an admin enables
 * external access an outside MCP client lists `covenant-ping` and calls it.
 * Fallback if it fails: switch the bonus target to the Rovo agent.
 *
 * The docs do not say what `context` holds or whether the function runs as the
 * user, so this tool reports the shape of what it was handed: key names, path
 * names, statuses and counts only, never values.
 */

export interface PingResult {
  ok: true;
  tool: 'covenant-ping';
  noteLength: number;
  payloadKeys: string[];
  contextKeys: string[];
  /** Key names inside `context.principal` and `payload.context`, if present. */
  principalKeys: string[];
  payloadContextKeys: string[];
  /** Whether an account id was found anywhere the docs suggest it might be. */
  callerIdentified: boolean;
  /** Where it was found: a path name, never the id. */
  callerSource: string | null;
  /** Whether a Jira call made with api.asUser() works inside an MCP tool call. */
  asUser: { status: number; rows: number } | { error: string };
}

const keysOf = (value: unknown): string[] => (value !== null && typeof value === 'object' ? Object.keys(value).sort() : []);

const pick = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

async function probeAsUser(): Promise<PingResult['asUser']> {
  try {
    // Needs only read:jira-work. currentUser() resolves to whoever the call runs as.
    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/search/jql?jql=${'assignee = currentUser()'}&maxResults=5&fields=${'key'}`, {
        headers: { Accept: 'application/json' },
      });
    const body = response.ok ? ((await response.json()) as { issues?: unknown[] }) : {};
    return { status: response.status, rows: Array.isArray(body.issues) ? body.issues.length : 0 };
  } catch (caught) {
    return { error: caught instanceof Error ? caught.name : 'non-error thrown' };
  }
}

export async function spikePing(payload: unknown, context: unknown): Promise<PingResult> {
  const note = pick(payload, ['note']);
  const sources: Array<[string, unknown]> = [
    ['context.accountId', pick(context, ['accountId'])],
    ['context.principal.accountId', pick(context, ['principal', 'accountId'])],
    ['payload.context.accountId', pick(payload, ['context', 'accountId'])],
  ];
  const found = sources.find(([, value]) => nonEmptyString(value));

  const result: PingResult = {
    ok: true,
    tool: 'covenant-ping',
    noteLength: typeof note === 'string' ? note.length : 0,
    payloadKeys: keysOf(payload),
    contextKeys: keysOf(context),
    principalKeys: keysOf(pick(context, ['principal'])),
    payloadContextKeys: keysOf(pick(payload, ['context'])),
    callerIdentified: found !== undefined,
    callerSource: found?.[0] ?? null,
    asUser: await probeAsUser(),
  };
  console.log(
    `spike s4 ping payloadKeys=${result.payloadKeys.join(',')} contextKeys=${result.contextKeys.join(',')} ` +
      `principalKeys=${result.principalKeys.join(',')} payloadContextKeys=${result.payloadContextKeys.join(',')} ` +
      `caller=${result.callerIdentified} callerSource=${result.callerSource ?? 'none'} asUser=${JSON.stringify(result.asUser)}`,
  );
  return result;
}
