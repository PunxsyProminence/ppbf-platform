import { GYM_TIME_ZONE } from '../../lib/gymTime';
import { NO_ATHLETE_NOTE_PLACEHOLDER } from '../../shared/sessionNoteSemantics';

import { queryOne } from './db';
import { getTodaySessionNote } from './sessionNotes';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

const ORG = 'punxsy_prominence';
const ATHLETE = 'athlete-1';

/** The SQL and bound parameters the function actually built for this call. */
function lastCall(): { sql: string; params: unknown[] } {
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  const [sql, params] = mockQueryOne.mock.calls[0];
  return { sql: String(sql), params: params as unknown[] };
}

// The bug this module exists to avoid is a whole-evening one: a coach on the
// floor at 8pm being told the athlete in front of them has no session today,
// because the stored `date` is UTC and has already become tomorrow. These
// cases read the query the function actually constructs rather than comparing
// two date literals, so a change that quietly reintroduces the UTC day fails
// here rather than at the gym.

describe('the day it asks the database about', () => {
  it('uses the gym-evening day, not the UTC day that has already rolled over', async () => {
    mockQueryOne.mockResolvedValue(null);

    // 2026-09-25 20:30 in America/New_York is 2026-09-26 00:30 UTC.
    // A UTC-derived day would say 2026-09-26 and find nothing.
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-26T00:30:00Z');

    const { params } = lastCall();
    expect(params).toEqual([ORG, ATHLETE, '2026-09-25']);
  });

  it('still agrees with UTC earlier in the same day', async () => {
    mockQueryOne.mockResolvedValue(null);
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-25T18:00:00Z');
    expect(lastCall().params).toEqual([ORG, ATHLETE, '2026-09-25']);
  });

  it('reduces created_at in the gym zone rather than reading it in UTC', async () => {
    mockQueryOne.mockResolvedValue(null);
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-25T18:00:00Z');

    const { sql } = lastCall();
    expect(sql).toContain(`(created_at at time zone '${GYM_TIME_ZONE}')::date`);
    expect(GYM_TIME_ZONE).toBe('America/New_York');
  });

  // Not "a malformed date column is handled" -- the column is never consulted,
  // which is why nothing it contains can move a session between days.
  it('never consults the drifting date column', async () => {
    mockQueryOne.mockResolvedValue(null);
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-25T18:00:00Z');

    // Strip the ::date casts first: those are the reduction this module does
    // ON created_at, not a reference to the stored `date` column. What must
    // not appear is the column itself.
    const sqlWithoutCasts = lastCall().sql.replace(/::date/g, '');
    expect(sqlWithoutCasts).not.toMatch(/\bdate\b/);
  });

  // The database does the ordering; what this pins is that it was ASKED to.
  // A unit test with a mocked driver cannot prove Postgres sorted correctly.
  it('asks for the newest session of the day, one row', async () => {
    mockQueryOne.mockResolvedValue(null);
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-25T18:00:00Z');

    const { sql } = lastCall();
    expect(sql).toMatch(/order\s+by\s+created_at\s+desc/i);
    expect(sql).toMatch(/limit\s+1/i);
  });

  it('binds the athlete and organization rather than interpolating them', async () => {
    mockQueryOne.mockResolvedValue(null);
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-25T18:00:00Z');

    const { sql } = lastCall();
    expect(sql).not.toContain(ATHLETE);
    expect(sql).not.toContain(ORG);
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('$3');
  });
});

describe('what it gives back', () => {
  it('returns null when no session was started today', async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toBeNull();
  });

  it('returns the athlete’s words exactly, line breaks intact', async () => {
    const written = 'Left shoulder is still sore.\n\nGoing to go light on the bag.';
    mockQueryOne.mockResolvedValue({ notes: written });
    await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toEqual({ note: written });
  });

  // A session with no human note is NOT the same answer as no session, and
  // the coach screen says different things for the two.
  it('distinguishes "session, no note" from "no session"', async () => {
    mockQueryOne.mockResolvedValue({ notes: NO_ATHLETE_NOTE_PLACEHOLDER });
    await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toEqual({ note: null });
  });

  it.each(['GREEN', 'YELLOW', 'RED'])(
    'never hands out the historical Auto check-in readiness %s as a human note',
    async (band) => {
      mockQueryOne.mockResolvedValue({ notes: `Auto check-in readiness ${band}` });
      await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toEqual({ note: null });
    },
  );

  // The column is `not null`, but nothing in the schema forbids '' -- the
  // write path's requireString does, and scripts/seed-data.ts does not use
  // it. A blank note rendered on a coach's screen is a note that says nothing
  // while looking like one was written.
  it.each([
    ['an empty string', ''],
    ['a single space', ' '],
    ['whitespace and newlines only', '  \n\t \n '],
  ])('treats %s as no note', async (_label, stored) => {
    mockQueryOne.mockResolvedValue({ notes: stored });
    await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toEqual({ note: null });
  });

  // Defensive rather than expected: the schema says not null, so this is
  // about not crashing if the driver ever hands back something else.
  it('treats a null note as no note', async () => {
    mockQueryOne.mockResolvedValue({ notes: null });
    await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toEqual({ note: null });
  });

  // Suppressing blank notes must not start trimming real ones: the spacing
  // and line breaks an athlete typed are theirs.
  it('keeps the surrounding whitespace of a real note', async () => {
    const typed = '  wrist is sore\n\n  ';
    mockQueryOne.mockResolvedValue({ notes: typed });
    await expect(getTodaySessionNote(ORG, ATHLETE)).resolves.toEqual({ note: typed });
  });

  it('returns only the note -- no rpe, completion or anything else off the row', async () => {
    mockQueryOne.mockResolvedValue({ notes: 'ready', rpe: 7, completed_flag: true, session_id: 's-1' });
    const result = await getTodaySessionNote(ORG, ATHLETE);
    expect(result).toEqual({ note: 'ready' });
    expect(Object.keys(result ?? {})).toEqual(['note']);
  });

  it('selects only the note column', async () => {
    mockQueryOne.mockResolvedValue(null);
    await getTodaySessionNote(ORG, ATHLETE, '2026-09-25T18:00:00Z');
    expect(lastCall().sql).toMatch(/select\s+notes\s/i);
  });
});

it('refuses rather than guessing a day it cannot resolve', async () => {
  mockQueryOne.mockResolvedValue(null);
  await expect(getTodaySessionNote(ORG, ATHLETE, 'not-a-date')).rejects.toThrow(
    'SESSION_NOTE_GYM_DAY_UNRESOLVED',
  );
  expect(mockQueryOne).not.toHaveBeenCalled();
});
