import { describe, expect, it } from 'vitest';
import { FALLBACK_MODEL, PRODUCTION_MODEL, normaliseToolArguments, repairInstruction, replayableArguments } from '../src/llm';

describe('repair helpers', () => {
  it('words the rejection the same way for every adapter', () => {
    expect(repairInstruction('record_contract', ['a: bad', 'b: worse'])).toBe(
      'Rejected. Fix these problems and call record_contract again with the whole answer: a: bad; b: worse',
    );
  });

  it('replays only JSON objects', () => {
    expect(replayableArguments('{"a":1}')).toEqual({ a: 1 });
    expect(replayableArguments('[1]')).toBeNull();
    expect(replayableArguments('{"a":')).toBeNull();
  });
});

describe('model ids', () => {
  it('names the one Haiku Forge offers, with a Sonnet fallback', () => {
    // The eval imports PRODUCTION_MODEL too, so its numbers describe this exact model.
    expect(PRODUCTION_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(FALLBACK_MODEL).toBe('claude-sonnet-4-6');
  });
});

describe('normaliseToolArguments', () => {
  it('passes a JSON string through, since Forge LLM sends one despite its types', () => {
    expect(normaliseToolArguments('{"a":1}')).toBe('{"a":1}');
  });

  it('serialises an object, which is what the Anthropic API sends', () => {
    expect(normaliseToolArguments({ a: 1, b: [true, null] })).toBe('{"a":1,"b":[true,null]}');
  });

  it('returns null when there were no arguments at all', () => {
    expect(normaliseToolArguments(undefined)).toBeNull();
    expect(normaliseToolArguments(null)).toBeNull();
  });

  it('keeps a string that is not valid JSON, so validation can report it', () => {
    expect(normaliseToolArguments('{"a":')).toBe('{"a":');
  });
});
