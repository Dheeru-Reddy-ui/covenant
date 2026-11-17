import { type Message, type ToolSchema, chat, list } from '@forge/llm';
import {
  type LlmClient,
  PRODUCTION_MODEL,
  REPAIR_CALL_ID,
  type ToolCallRequest,
  type ToolCallResponse,
  chooseModel,
  normaliseToolArguments,
  repairInstruction,
  replayableArguments,
} from '../../../packages/core/src';
import { loggableError } from '../errors';
import { withRetries } from '../retry';

const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
let chosen: { model: string; atMs: number } | null = null;

/**
 * The model Forge LLMs offers now: production while it is listed, the fallback
 * once it is retired (core's chooseModel). Asked at most every ten minutes per
 * function instance. A failed list keeps the production model.
 */
export async function currentModel(nowMs: number = Date.now()): Promise<string> {
  if (chosen !== null && nowMs - chosen.atMs < MODEL_LIST_TTL_MS) return chosen.model;
  let offered: Array<{ model: string }> | null = null;
  try {
    offered = (await list()).models;
  } catch (error) {
    console.error(`model list failed error=${loggableError(error)}`);
  }
  const model = chooseModel(offered);
  if (chosen?.model !== model) console.log(`model chosen=${model} listed=${offered === null ? 'unknown' : offered.length}`);
  chosen = { model, atMs: nowMs };
  return model;
}

const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Too many requests, or the model service is overloaded or briefly down. A bad
 * request is not retried. @forge/llm does not export ForgeLlmAPIError, so it is
 * recognised by its name and status.
 */
const isBusy = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name !== 'ForgeLlmAPIError') return false;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === 'number' && BUSY_STATUSES.has(status);
};

/**
 * Production adapter: core's LlmClient over Forge LLMs (`@forge/llm` chat()).
 *
 * Forge LLMs has no JSON mode, so structure is forced with one tool named in
 * tool_choice (spike S2). Tool arguments are JSON strings in both directions
 * although the SDK types say object; normaliseToolArguments accepts both.
 *
 * Sampling must match the eval's adapter (eval/src/anthropic-client.ts):
 * temperature 0, same model id, same repair wording. With no model given, it
 * calls currentModel(): the eval's model until Forge retires it.
 */
export class ForgeLlmClient implements LlmClient {
  private lastModel: string | null = null;

  constructor(readonly fixedModel: string | null = null) {}

  /** The model this client last called, which core records on the run; before any call, the one it would start with. */
  get modelId(): string {
    return this.lastModel ?? this.fixedModel ?? PRODUCTION_MODEL;
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    const modelId = this.fixedModel ?? (await currentModel());
    this.lastModel = modelId;
    const tools: ToolSchema[] = [
      { type: 'function', function: { name: request.tool.name, description: request.tool.description, parameters: request.tool.parameters } },
    ];
    const messages: Message[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    if (request.repair) {
      messages.push({
        role: 'assistant',
        // '' becomes an empty text block, which the model API rejects; no parts matches the eval's tool_use-only turn.
        content: [],
        tool_calls: [
          {
            id: REPAIR_CALL_ID,
            type: 'function',
            index: 0,
            // The SDK types say object, but Forge LLM rejects an object here with HTTP 400; it wants a JSON string (spike S2b).
            function: {
              name: request.tool.name,
              arguments: JSON.stringify(replayableArguments(request.repair.previousArguments) ?? {}) as unknown as object,
            },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: REPAIR_CALL_ID,
        name: request.tool.name,
        content: repairInstruction(request.tool.name, request.repair.problems),
      });
    }

    // Rate limits (100 requests and 500k tokens a minute per install) and overload pass with a wait.
    // This runs in the extraction worker, which has 900 s, so it can afford to wait half a minute.
    const response = await withRetries(
      () =>
        chat({
          model: modelId,
          temperature: 0,
          max_completion_tokens: request.maxOutputTokens,
          messages,
          tools,
          tool_choice: { type: 'function', function: { name: request.tool.name } },
        }),
      { retryable: () => false, retryableError: isBusy, delaysMs: [5_000, 25_000] },
    );
    const choice = response.choices[0];
    const call = choice?.message.tool_calls?.find((c) => c.function.name === request.tool.name);
    return {
      argumentsJson: normaliseToolArguments(call?.function.arguments),
      usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
      model: modelId,
      stopReason: choice?.finish_reason ?? null,
    };
  }
}
