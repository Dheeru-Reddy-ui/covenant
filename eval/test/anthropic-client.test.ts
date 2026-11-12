import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_MODEL, REPAIR_CALL_ID, repairInstruction } from '../../packages/core/src';
import { AnthropicLlmClient, type MessagesApi } from '../src/anthropic-client';

class FakeMessages implements MessagesApi {
  readonly bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private readonly content: Anthropic.ContentBlock[]) {}
  async create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.bodies.push(body);
    return {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: this.content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1234, output_tokens: 56 },
    } as Anthropic.Message;
  }
}

const tool = { name: 'record_contract', description: 'Record it.', parameters: { type: 'object', properties: { a: { type: 'string' } } } };

describe('AnthropicLlmClient', () => {
  it('calls the production model at temperature 0 with the one tool forced', async () => {
    const fake = new FakeMessages([{ type: 'tool_use', id: 't1', name: 'record_contract', input: { a: 'x' } } as Anthropic.ContentBlock]);
    const client = new AnthropicLlmClient(fake);
    const response = await client.callTool({ system: 'sys', prompt: 'read this', tool, maxOutputTokens: 900 });

    expect(client.modelId).toBe(PRODUCTION_MODEL);
    const [body] = fake.bodies;
    expect(body).toMatchObject({
      model: PRODUCTION_MODEL,
      temperature: 0,
      max_tokens: 900,
      system: 'sys',
      messages: [{ role: 'user', content: 'read this' }],
      tools: [{ name: 'record_contract', description: 'Record it.', input_schema: tool.parameters }],
      tool_choice: { type: 'tool', name: 'record_contract' },
    });
    expect(response).toEqual({
      argumentsJson: '{"a":"x"}',
      usage: { inputTokens: 1234, outputTokens: 56 },
      model: 'claude-haiku-4-5-20251001',
      stopReason: 'tool_use',
    });
    expect([...client.reportedModels]).toEqual(['claude-haiku-4-5-20251001']);
  });

  it('replays a rejected call and returns the problems as an error result', async () => {
    const fake = new FakeMessages([{ type: 'tool_use', id: 't2', name: 'record_contract', input: { a: 'y' } } as Anthropic.ContentBlock]);
    await new AnthropicLlmClient(fake).callTool({
      system: 'sys',
      prompt: 'read this',
      tool,
      maxOutputTokens: 900,
      repair: { previousArguments: '{"a":1}', problems: ['a: expected string'] },
    });
    expect(fake.bodies[0]?.messages).toEqual([
      { role: 'user', content: 'read this' },
      { role: 'assistant', content: [{ type: 'tool_use', id: REPAIR_CALL_ID, name: 'record_contract', input: { a: 1 } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: REPAIR_CALL_ID, is_error: true, content: repairInstruction('record_contract', ['a: expected string']) }],
      },
    ]);
  });

  it('reports no tool call as null arguments', async () => {
    const fake = new FakeMessages([{ type: 'text', text: 'no', citations: null } as Anthropic.ContentBlock]);
    const response = await new AnthropicLlmClient(fake).callTool({ system: 's', prompt: 'p', tool, maxOutputTokens: 10 });
    expect(response.argumentsJson).toBeNull();
  });
});
