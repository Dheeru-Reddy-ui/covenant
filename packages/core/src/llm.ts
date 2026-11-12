/**
 * The one door every model call goes through. Core describes what it wants
 * (a system prompt, a user prompt, one tool the model must call) and an
 * adapter speaks the provider's wire format: Forge LLM in production, the
 * Anthropic API directly for the offline eval. Both must call the same model,
 * or the eval describes a different system.
 */

/** The only Haiku on Forge LLM. Its earliest retirement date (15 Oct 2026) has passed, so keep the fallback ready. */
export const PRODUCTION_MODEL = 'claude-haiku-4-5-20251001';
export const FALLBACK_MODEL = 'claude-sonnet-4-6';

export interface LlmTool {
  name: string;
  /** Written for the model: what the tool records and the rules it cannot see in the schema. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCallRequest {
  system: string;
  prompt: string;
  /** The model is forced to call this tool and nothing else. */
  tool: LlmTool;
  maxOutputTokens: number;
  /**
   * Set on the single retry after a rejected answer. The adapter replays the
   * model's previous call and returns `problems` to it as the tool's error result.
   */
  repair?: { previousArguments: string; problems: string[] };
}

export interface ToolCallResponse {
  /** The tool's arguments as JSON text, exactly as the model sent them. Null when the model did not call the tool. */
  argumentsJson: string | null;
  usage: LlmUsage;
  /** The model the provider says answered. */
  model: string;
  /** The provider's stop or finish reason, for diagnosing truncation. */
  stopReason: string | null;
}

export interface LlmClient {
  /** The model this client asks for. Recorded on every extraction run. */
  readonly modelId: string;
  callTool(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/**
 * Tool arguments as JSON text, whatever shape the provider used. Forge LLM sends a
 * string although its SDK types say object (spike S2); the Anthropic API sends an
 * object. A string that is not valid JSON is kept as it is for validation to reject.
 */
export function normaliseToolArguments(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw);
}

/** The id adapters give the replayed call in a repair turn. */
export const REPAIR_CALL_ID = 'covenant_repair_0';

/** What the model is told when its answer is sent back. Both adapters send exactly this, so the eval and production repair the same way. */
export function repairInstruction(toolName: string, problems: readonly string[]): string {
  return `Rejected. Fix these problems and call ${toolName} again with the whole answer: ${problems.join('; ')}`;
}

/**
 * The previous arguments as a JSON object for replaying the call, or null when
 * they were not a JSON object (then the adapter replays an empty object and
 * the problems list says why).
 */
export function replayableArguments(previousArguments: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(previousArguments);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

export const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };
