import Anthropic from '@anthropic-ai/sdk';
import {
  type LlmClient,
  PRODUCTION_MODEL,
  REPAIR_CALL_ID,
  type ToolCallRequest,
  type ToolCallResponse,
  normaliseToolArguments,
  repairInstruction,
  replayableArguments,
} from '../../packages/core/src';

/**
 * Eval adapter: core's LlmClient over the Anthropic Messages API, calling the
 * same model as production (PRODUCTION_MODEL) the way the Forge adapter does:
 * temperature 0, one tool forced with tool_choice, the same repair wording.
 *
 * Pinned to SDK 0.137.0, the last release that sends API version 2023-06-01.
 * From 1.0.0 the SDK sends 2026-10-21, which rejects `temperature` on every
 * model, and production runs Haiku 4.5 at temperature 0 on Forge.
 */

export const SDK_VERSION = '0.137.0';
export const API_VERSION = '2023-06-01';
export const TEMPERATURE = 0;

/** The one SDK method this adapter uses, so tests can stand in for it. */
export interface MessagesApi {
  create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export class AnthropicLlmClient implements LlmClient {
  /** Model ids the API reported answering with, for the report. */
  readonly reportedModels = new Set<string>();

  constructor(
    private readonly messages: MessagesApi,
    readonly modelId: string = PRODUCTION_MODEL,
  ) {}

  /** Credentials come from the environment (ANTHROPIC_API_KEY); this code never reads or prints them. */
  static fromEnvironment(modelId: string = PRODUCTION_MODEL): AnthropicLlmClient {
    return new AnthropicLlmClient(new Anthropic({ maxRetries: 4 }).messages, modelId);
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    const { name, description, parameters } = request.tool;
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.prompt }];
    if (request.repair) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: REPAIR_CALL_ID, name, input: replayableArguments(request.repair.previousArguments) ?? {} }],
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: REPAIR_CALL_ID, is_error: true, content: repairInstruction(name, request.repair.problems) }],
      });
    }

    const response = await this.messages.create({
      model: this.modelId,
      max_tokens: request.maxOutputTokens,
      temperature: TEMPERATURE,
      system: request.system,
      messages,
      tools: [{ name, description, input_schema: parameters as Anthropic.Tool.InputSchema }],
      tool_choice: { type: 'tool', name },
    });
    this.reportedModels.add(response.model);
    const call = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === name);
    return {
      argumentsJson: normaliseToolArguments(call?.input),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: response.model,
      stopReason: response.stop_reason ?? null,
    };
  }
}
