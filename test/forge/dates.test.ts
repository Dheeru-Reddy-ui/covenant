import { describe, expect, it } from 'vitest';
import { todayIn } from '../../src/forge/dates';

// 12 Nov 2026, 19:00 UTC: already the 13th in India, still the 12th in New York.
const EVENING_UTC = Date.UTC(2026, 10, 12, 19, 0, 0);

describe('todayIn', () => {
  it("gives today's date on the caller's calendar", () => {
    expect(todayIn('Asia/Kolkata', EVENING_UTC)).toEqual({ today: '2026-11-13', timeZone: 'Asia/Kolkata' });
    expect(todayIn('America/New_York', EVENING_UTC)).toEqual({ today: '2026-11-12', timeZone: 'America/New_York' });
    expect(todayIn('Pacific/Kiritimati', Date.UTC(2026, 11, 31, 11, 0, 0))).toEqual({ today: '2027-01-01', timeZone: 'Pacific/Kiritimati' });
  });

  it('falls back to UTC, and says so, when the zone is missing or unknown', () => {
    expect(todayIn(null, EVENING_UTC)).toEqual({ today: '2026-11-12', timeZone: 'UTC' });
    expect(todayIn(undefined, EVENING_UTC)).toEqual({ today: '2026-11-12', timeZone: 'UTC' });
    expect(todayIn('Mars/Olympus_Mons', EVENING_UTC)).toEqual({ today: '2026-11-12', timeZone: 'UTC' });
  });
});
