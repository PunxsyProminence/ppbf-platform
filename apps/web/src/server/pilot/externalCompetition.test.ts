// Unit coverage for the board aggregate added to externalCompetition.ts.
// The module's CRUD paths (competitions/entries) are proven against a real
// Postgres in externalCompetition.pg.test.ts; this file covers only
// getBoardExternalCompetitionSummary's k-anonymity gating, which is pure
// application logic that a DB round-trip cannot exercise any better than a
// mock.

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { getBoardExternalCompetitionSummary } from './externalCompetition';
import { queryOne } from './db';

const mockQueryOne = jest.mocked(queryOne);

afterEach(() => {
  jest.clearAllMocks();
});

describe('getBoardExternalCompetitionSummary', () => {
  test('a win/loss cohort under the minimum comes back insufficient_data per bucket, never a small real number', async () => {
    mockQueryOne.mockResolvedValueOnce({
      competitions_planned: 1,
      competitions_completed: 1,
      competitions_cancelled: 0,
      result_won: 3,
      result_won_athletes: 3,
      result_lost: 1,
      result_lost_athletes: 1,
      result_draw: 0,
      result_draw_athletes: 0,
      result_no_contest: 0,
      result_no_contest_athletes: 0,
    } as never);

    const summary = await getBoardExternalCompetitionSummary('org-1');

    expect(summary.entriesByResult.won).toEqual({ status: 'insufficient_data', count: null });
    expect(summary.entriesByResult.lost).toEqual({ status: 'insufficient_data', count: null });
  });

  test('each result bucket is gated independently -- a large total does not rescue a small bucket', async () => {
    mockQueryOne.mockResolvedValueOnce({
      competitions_planned: 0,
      competitions_completed: 10,
      competitions_cancelled: 0,
      // 20 wins across enough athletes to clear the floor...
      result_won: 20,
      result_won_athletes: 12,
      // ...but only one athlete ever lost, so that bucket alone stays withheld.
      result_lost: 1,
      result_lost_athletes: 1,
      result_draw: 0,
      result_draw_athletes: 0,
      result_no_contest: 0,
      result_no_contest_athletes: 0,
    } as never);

    const summary = await getBoardExternalCompetitionSummary('org-1');

    expect(summary.entriesByResult.won).toEqual({ status: 'available', count: 20 });
    expect(summary.entriesByResult.lost).toEqual({ status: 'insufficient_data', count: null });
  });

  test('an empty ledger reports unavailable, distinguishable from a suppressed cohort', async () => {
    mockQueryOne.mockResolvedValueOnce({
      competitions_planned: 0,
      competitions_completed: 0,
      competitions_cancelled: 0,
      result_won: 0,
      result_won_athletes: 0,
      result_lost: 0,
      result_lost_athletes: 0,
      result_draw: 0,
      result_draw_athletes: 0,
      result_no_contest: 0,
      result_no_contest_athletes: 0,
    } as never);

    const summary = await getBoardExternalCompetitionSummary('org-1');

    expect(summary.entriesByResult.won).toEqual({ status: 'unavailable', count: null });
  });

  test('carries the same minimum cohort size and scope as every other board aggregate', async () => {
    mockQueryOne.mockResolvedValueOnce({
      competitions_planned: 0,
      competitions_completed: 0,
      competitions_cancelled: 0,
      result_won: 0,
      result_won_athletes: 0,
      result_lost: 0,
      result_lost_athletes: 0,
      result_draw: 0,
      result_draw_athletes: 0,
      result_no_contest: 0,
      result_no_contest_athletes: 0,
    } as never);

    const summary = await getBoardExternalCompetitionSummary('org-1');

    expect(summary.scope).toBe('organization_aggregate');
    expect(summary.minimumCohortSize).toBe(5);
  });

  test('never returns an entry_id, athlete_id, athlete name, or lesson note -- counts only', async () => {
    mockQueryOne.mockResolvedValueOnce({
      competitions_planned: 2,
      competitions_completed: 6,
      competitions_cancelled: 1,
      result_won: 14,
      result_won_athletes: 9,
      result_lost: 8,
      result_lost_athletes: 6,
      result_draw: 2,
      result_draw_athletes: 2,
      result_no_contest: 1,
      result_no_contest_athletes: 1,
    } as never);

    const summary = await getBoardExternalCompetitionSummary('org-1');

    expect(JSON.stringify(summary)).not.toMatch(
      /athlete_id|athleteId|entry_id|entryId|athlete_name|athleteName|lesson_note|lessonNote/i,
    );
  });

  test('a missing row (no organization match) reads as an empty, unavailable aggregate rather than throwing', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const summary = await getBoardExternalCompetitionSummary('org-unknown');

    expect(summary.competitionsByStatus).toEqual({ planned: 0, completed: 0, cancelled: 0 });
    expect(summary.entriesByResult.won).toEqual({ status: 'unavailable', count: null });
  });
});
