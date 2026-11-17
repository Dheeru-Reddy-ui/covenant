import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The daily limit on document readings: model tokens are billed to the app's developer. */

const h = vi.hoisted(() => ({ used: 0, since: [] as number[] }));

vi.mock('../../src/forge/db/repo', () => ({
  countModelJobsSince: async (sinceMs: number) => {
    h.since.push(sinceMs);
    return h.used;
  },
}));

const { DAILY_MODEL_JOBS, requireModelBudget } = await import('../../src/forge/budget');
const { UserFacingError } = await import('../../src/forge/errors');

const NOW = Date.parse('2026-11-17T12:00:00Z');

beforeEach(() => {
  h.used = 0;
  h.since.length = 0;
});

describe('requireModelBudget', () => {
  it('counts the readings of the last 24 hours', async () => {
    await requireModelBudget(NOW);
    expect(h.since).toEqual([NOW - 24 * 60 * 60 * 1000]);
  });

  it('lets a reading through below the limit', async () => {
    h.used = DAILY_MODEL_JOBS - 1;
    await expect(requireModelBudget(NOW)).resolves.toBeUndefined();
  });

  it('refuses at the limit, in words a person can act on', async () => {
    h.used = DAILY_MODEL_JOBS;
    const refusal = requireModelBudget(NOW);
    await expect(refusal).rejects.toBeInstanceOf(UserFacingError);
    await expect(requireModelBudget(NOW)).rejects.toThrow(/Try again tomorrow/);
  });

  it('leaves room for the sample workspace several times over', () => {
    // Setup reads three sample contracts and their details: six readings.
    expect(DAILY_MODEL_JOBS).toBeGreaterThanOrEqual(6 * 5);
  });
});
