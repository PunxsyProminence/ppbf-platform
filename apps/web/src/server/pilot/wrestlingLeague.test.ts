// Unit coverage for the board aggregate added to wrestlingLeague.ts. The
// module's CRUD paths (seasons/events/roster) are proven against a real
// Postgres in wrestlingLeague.pg.test.ts; this file covers only
// getBoardWrestlingLeagueSummary's k-anonymity gating, which is pure
// application logic that a DB round-trip cannot exercise any better than a
// mock.

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { getBoardWrestlingLeagueSummary } from './wrestlingLeague';
import { queryOne } from './db';

const mockQueryOne = jest.mocked(queryOne);

afterEach(() => {
  jest.clearAllMocks();
});

describe('getBoardWrestlingLeagueSummary', () => {
  test('a rostered-athlete cohort under the minimum comes back insufficient_data, never a small real number', async () => {
    mockQueryOne.mockResolvedValueOnce({
      seasons_planned: 1,
      seasons_active: 1,
      seasons_completed: 0,
      rostered_entry_count: 4,
      rostered_athlete_count: 3,
    } as never);

    const summary = await getBoardWrestlingLeagueSummary('org-1');

    expect(summary.rosteredAthletes.status).toBe('insufficient_data');
    expect(summary.rosteredAthletes.count).toBeNull();
  });

  test('a cohort at or above the minimum reports the real count', async () => {
    mockQueryOne.mockResolvedValueOnce({
      seasons_planned: 0,
      seasons_active: 2,
      seasons_completed: 1,
      rostered_entry_count: 12,
      rostered_athlete_count: 8,
    } as never);

    const summary = await getBoardWrestlingLeagueSummary('org-1');

    expect(summary.rosteredAthletes).toEqual({ status: 'available', count: 12 });
    expect(summary.seasonsByStatus).toEqual({ planned: 0, active: 2, completed: 1 });
  });

  test('an empty league reports unavailable, distinguishable from a suppressed cohort', async () => {
    mockQueryOne.mockResolvedValueOnce({
      seasons_planned: 0,
      seasons_active: 0,
      seasons_completed: 0,
      rostered_entry_count: 0,
      rostered_athlete_count: 0,
    } as never);

    const summary = await getBoardWrestlingLeagueSummary('org-1');

    expect(summary.rosteredAthletes).toEqual({ status: 'unavailable', count: null });
  });

  test('carries the same minimum cohort size and scope as every other board aggregate', async () => {
    mockQueryOne.mockResolvedValueOnce({
      seasons_planned: 0,
      seasons_active: 0,
      seasons_completed: 0,
      rostered_entry_count: 0,
      rostered_athlete_count: 0,
    } as never);

    const summary = await getBoardWrestlingLeagueSummary('org-1');

    expect(summary.scope).toBe('organization_aggregate');
    expect(summary.minimumCohortSize).toBe(5);
  });

  test('never returns an entry_id, athlete_id, or athlete name -- counts only', async () => {
    mockQueryOne.mockResolvedValueOnce({
      seasons_planned: 1,
      seasons_active: 3,
      seasons_completed: 2,
      rostered_entry_count: 9,
      rostered_athlete_count: 7,
    } as never);

    const summary = await getBoardWrestlingLeagueSummary('org-1');

    expect(JSON.stringify(summary)).not.toMatch(/athlete_id|athleteId|entry_id|entryId|athlete_name|athleteName/i);
  });

  test('a missing row (no organization match) reads as an empty, unavailable aggregate rather than throwing', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const summary = await getBoardWrestlingLeagueSummary('org-unknown');

    expect(summary.seasonsByStatus).toEqual({ planned: 0, active: 0, completed: 0 });
    expect(summary.rosteredAthletes).toEqual({ status: 'unavailable', count: null });
  });
});
