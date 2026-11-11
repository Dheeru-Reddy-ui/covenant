/**
 * S4: one tool exposed through the rovo:mcp module.
 *
 * Pass: the app deploys with the rovo:mcp module, and after an admin enables
 * external access an outside MCP client lists `covenant-ping` and calls it.
 * Fallback if it fails: switch the bonus target to the Rovo agent.
 *
 * The docs do not say what `context` holds or whether the function runs as the
 * user, so this tool reports the shape of what it was handed: key names only,
 * never values.
 */

export interface PingResult {
  ok: true;
  tool: 'covenant-ping';
  noteLength: number;
  payloadKeys: string[];
  contextKeys: string[];
  /** Whether an account id was found anywhere the docs suggest it might be. */
  callerIdentified: boolean;
}

const keysOf = (value: unknown): string[] => (value !== null && typeof value === 'object' ? Object.keys(value).sort() : []);

const pick = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

export async function spikePing(payload: unknown, context: unknown): Promise<PingResult> {
  const note = pick(payload, ['note']);
  const accountId = pick(context, ['accountId']) ?? pick(context, ['principal', 'accountId']) ?? pick(payload, ['context', 'accountId']);

  const result: PingResult = {
    ok: true,
    tool: 'covenant-ping',
    noteLength: typeof note === 'string' ? note.length : 0,
    payloadKeys: keysOf(payload),
    contextKeys: keysOf(context),
    callerIdentified: typeof accountId === 'string' && accountId.length > 0,
  };
  console.log(`spike s4 ping payloadKeys=${result.payloadKeys.join(',')} contextKeys=${result.contextKeys.join(',')} caller=${result.callerIdentified}`);
  return result;
}
