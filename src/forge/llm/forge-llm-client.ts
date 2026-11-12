import { type Message, type ToolSchema, chat } from '@forge/llm';
import {
  type LlmClient,
  PRODUCTION_MODEL,
  REPAIR_CALL_ID,
  type ToolCallRequest,
  type ToolCallResponse,
  normaliseToolArguments,
  repairInstruction,
  replayableArguments,
} from '../../../packages/core/src';

/**
 * Production adapter: core's LlmClient over Forge LLMs (`@forge/llm` chat()).
 *
 * Forge LLMs has no JSON mode, so structure is forced with one tool named in
 * tool_choice (spike S2). Tool arguments are JSON strings in both directions
 * although the SDK types say object; normaliseToolArguments accepts both.
 *
 * Sampling must match the eval's adapter (eval/src/anthropic-client.ts):
 * temperature 0, same model id, same repair wording.
 */
export class ForgeLlmClient implements LlmClient {
  constructor(readonly modelId: string = PRODUCTION_MODEL) {}

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
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

    const response = await chat({
      model: this.modelId,
      temperature: 0,
      max_completion_tokens: request.maxOutputTokens,
      messages,
      tools,
      tool_choice: { type: 'function', function: { name: request.tool.name } },
    });
    const choice = response.choices[0];
    const call = choice?.message.tool_calls?.find((c) => c.function.name === request.tool.name);
    return {
      argumentsJson: normaliseToolArguments(call?.function.arguments),
      usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
      model: this.modelId,
      stopReason: choice?.finish_reason ?? null,
    };
  }
}
