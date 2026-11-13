import { describe, expect, it } from 'vitest';
import { retryAfterMs, withRetries } from '../../src/forge/retry';

describe('withRetries', () => {
  it('returns at once when the first try is good, without waiting', async () => {
    const waits: number[] = [];
    const result = await withRetries(async () => 'ok', { retryable: () => false, delaysMs: [100, 200], sleep: async (ms) => void waits.push(ms) });
    expect(result).toBe('ok');
    expect(waits).toEqual([]);
  });

  it('retries a rate-limited result after each delay, then gives back the last result', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetries(async () => ({ status: ++calls < 3 ? 429 : 200 }), {
      retryable: (r) => r.status === 429,
      delaysMs: [100, 200],
      sleep: async (ms) => void waits.push(ms),
    });
    expect(result).toEqual({ status: 200 });
    expect(waits).toEqual([100, 200]);
  });

  it('stops after the last delay and returns the still-limited result for the caller to report', async () => {
    let calls = 0;
    const result = await withRetries(async () => ({ status: 429, n: ++calls }), {
      retryable: (r) => r.status === 429,
      delaysMs: [1, 1],
      sleep: async () => undefined,
    });
    expect(result).toEqual({ status: 429, n: 3 });
  });

  it('retries a thrown error only when it is retryable', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { status: 529 });
      return 'done';
    };
    await expect(
      withRetries(flaky, { retryable: () => false, retryableError: (e) => (e as { status?: number }).status === 529, delaysMs: [1], sleep: async () => undefined }),
    ).resolves.toBe('done');

    calls = 0;
    const broken = async () => {
      calls += 1;
      throw new Error('bad request');
    };
    await expect(withRetries(broken, { retryable: () => false, retryableError: () => false, delaysMs: [1, 1], sleep: async () => undefined })).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  it('lets the result choose its own wait, such as a Retry-After header, within a cap', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetries(async () => ({ status: ++calls === 1 ? 429 : 200, after: 30_000 }), {
      retryable: (r) => r.status === 429,
      delaysMs: [500],
      waitFor: (r) => r.after,
      maxWaitMs: 4_000,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([4_000]);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds, and ignores what it cannot read', () => {
    expect(retryAfterMs('3')).toBe(3_000);
    expect(retryAfterMs(' 0 ')).toBe(0);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});
