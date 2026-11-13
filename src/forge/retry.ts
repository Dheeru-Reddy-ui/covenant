/**
 * Waiting out rate limits. Jira, Forge LLMs and Teamwork Graph all answer
 * "too many requests" or "overloaded" under load; a short wait usually clears
 * it. Each caller picks delays that fit its time limit: a resolver has 25 s,
 * the extraction worker 900 s.
 */

export interface RetryOptions<T> {
  /** A result that should be tried again, such as an HTTP 429 response. */
  retryable: (result: T) => boolean;
  /** A thrown error that should be tried again. Others are thrown at once. */
  retryableError?: (error: unknown) => boolean;
  /** One wait per retry, so the number of retries is delaysMs.length. */
  delaysMs: readonly number[];
  /** A wait the result asks for, such as Retry-After, used instead of the planned delay. */
  waitFor?: (result: T) => number | null;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetries<T>(run: () => Promise<T>, options: RetryOptions<T>): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  const cap = options.maxWaitMs ?? Number.POSITIVE_INFINITY;
  for (let attempt = 0; ; attempt += 1) {
    const planned = options.delaysMs[attempt];
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (planned === undefined || !(options.retryableError?.(error) ?? false)) throw error;
      await sleep(Math.min(planned, cap));
      continue;
    }
    if (planned === undefined || !options.retryable(result)) return result;
    const asked = options.waitFor?.(result) ?? null;
    await sleep(Math.min(asked ?? planned, cap));
  }
}

/** A Retry-After header in seconds, as milliseconds. HTTP dates are rare from Atlassian and are ignored. */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null;
  const seconds = Number(header.trim());
  return header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
