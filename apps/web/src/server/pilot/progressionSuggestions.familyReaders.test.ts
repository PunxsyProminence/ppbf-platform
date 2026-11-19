// getFamilyGapReaders / readAthleteDobForFamilyWording (OD-2026-11-17-004,
// OW25-31 A): who counts as under-18 for the family load wording, and which
// week's numbers they read.
//
// Mocked-pool limits, stated rather than implied: these prove the SQL text and
// bind parameters sent and the projection of what comes back, not what
// Postgres returns.

import { query, queryOne } from './db';
import {
  ADULT_FAMILY_READER,
  getFamilyGapReaders,
  readAthleteDobForFamilyWording,
} from './progressionSuggestions';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

const NOW = new Date('2026-11-18T15:00:00Z');
const CONFIRMED_AT = '2026-11-14T17:30:00.000Z'; // Nov 14 at the gym
const RULE6 = 'deterministic_rule:load_jumped';
const RULE7 = 'deterministic_rule:load_up_wellness_down';

function buckets() {
  return [
    { athlete_id: 'ath-1', week_index: 0, week_load: 2400, session_count: 6, week_minutes: 410 },
    { athlete_id: 'ath-1', week_index: 1, week_load: 900, session_count: 3, week_minutes: 180 },
    { athlete_id: 'ath-1', week_index: 2, week_load: 1200, session_count: 4, week_minutes: 240 },
    { athlete_id: 'ath-1', week_index: 3, week_load: 1000, session_count: 3, week_minutes: 200 },
  ];
}

describe('getFamilyGapReaders', () => {
  test('an adult reads today\'s wording: no load read at all', async () => {
    const readers = await getFamilyGapReaders('org-1', 'ath-1', '1990-01-01', [
      { detected_from: RULE6, created_at: CONFIRMED_AT },
    ], NOW);
    expect(readers).toEqual([ADULT_FAMILY_READER]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('turning 18 is decided on the gym day at read time', async () => {
    expect((await getFamilyGapReaders('org-1', 'ath-1', '2008-11-18', [{ detected_from: RULE6, created_at: CONFIRMED_AT }], NOW))[0].minor)
      .toBe(false);
    mockQuery.mockResolvedValue([]);
    expect((await getFamilyGapReaders('org-1', 'ath-1', '2008-11-19', [{ detected_from: RULE6, created_at: CONFIRMED_AT }], NOW))[0].minor)
      .toBe(true);
  });

  test.each([
    ['an under-18', '2012-03-01'],
    ['an unknown date of birth (counts as a minor, OD-2026-10-04-010)', null],
    ['an unreadable date of birth', 'not a date'],
  ])('%s reads the confirmed week\'s numbers, anchored at the gap\'s created_at', async (_label, dob) => {
    mockQuery.mockResolvedValueOnce(buckets());
    const [reader] = await getFamilyGapReaders('org-1', 'ath-1', dob, [{ detected_from: RULE6, created_at: CONFIRMED_AT }], NOW);
    expect(reader).toEqual({
      minor: true,
      weekEnding: 'Nov 14',
      loadNumbers: {
        this_week: { sessions: 6, minutes: 410 },
        usual: { sessions_low: 3, sessions_high: 4, minutes_low: 180, minutes_high: 240 },
      },
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('from pilot.sessions');
    // The anchor is the confirm instant, not now: the numbers stay the
    // confirmed week's however late the family reads them.
    expect(params).toEqual(['org-1', ['ath-1'], 5, CONFIRMED_AT]);
  });

  test('a pg Date created_at anchors the same way', async () => {
    mockQuery.mockResolvedValueOnce(buckets());
    const [reader] = await getFamilyGapReaders('org-1', 'ath-1', null, [{ detected_from: RULE7, created_at: new Date(CONFIRMED_AT) }], NOW);
    expect(reader.weekEnding).toBe('Nov 14');
    expect(reader.loadNumbers?.this_week).toEqual({ sessions: 6, minutes: 410 });
  });

  test('one load read per distinct confirm day; other gaps need none', async () => {
    mockQuery.mockResolvedValue(buckets());
    const readers = await getFamilyGapReaders('org-1', 'ath-1', null, [
      { detected_from: RULE6, created_at: CONFIRMED_AT },
      { detected_from: RULE7, created_at: '2026-11-14T22:00:00.000Z' }, // still Nov 14 at the gym
      { detected_from: 'coach_observation', created_at: CONFIRMED_AT },
      { detected_from: 'deterministic_rule:readiness_falling', created_at: CONFIRMED_AT },
    ], NOW);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(readers.map((r) => r.minor)).toEqual([true, true, true, true]);
    expect(readers.map((r) => r.loadNumbers !== null)).toEqual([true, true, false, false]);
  });

  test.each([
    ['no created_at', undefined],
    ['an unreadable created_at', 'yesterday-ish'],
    ['a number', 1700000000000],
  ])('%s: no numbers and no read (the wording falls back to the no-number line)', async (_label, created_at) => {
    const [reader] = await getFamilyGapReaders('org-1', 'ath-1', null, [{ detected_from: RULE6, created_at }], NOW);
    expect(reader).toEqual({ minor: true, loadNumbers: null, weekEnding: null });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('too little history in the confirmed window: no numbers', async () => {
    mockQuery.mockResolvedValueOnce(buckets().slice(0, 3));
    const [reader] = await getFamilyGapReaders('org-1', 'ath-1', null, [{ detected_from: RULE6, created_at: CONFIRMED_AT }], NOW);
    expect(reader.loadNumbers).toBeNull();
  });

  // Overwatch 2026-11-19: a failed read costs only that gap its numbers; it is
  // logged with no athlete or record detail, and the other gaps still resolve.
  test('a failed load read gives that confirm day no numbers; other days and gaps still resolve', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockQuery
        .mockRejectedValueOnce(new Error('connection lost')) // the Nov 14 read
        .mockResolvedValueOnce(buckets()); // the Nov 10 read
      const readers = await getFamilyGapReaders('org-1', 'ath-1', null, [
        { detected_from: RULE6, created_at: CONFIRMED_AT },
        { detected_from: RULE7, created_at: CONFIRMED_AT },
        { detected_from: RULE6, created_at: '2026-11-10T17:00:00.000Z' },
        { detected_from: 'coach_observation', created_at: CONFIRMED_AT },
      ], NOW);
      expect(readers.map((r) => r.minor)).toEqual([true, true, true, true]);
      expect(readers.map((r) => r.loadNumbers !== null)).toEqual([false, false, true, false]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('family load numbers unread', { reason: 'connection lost' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('ath-1');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('readAthleteDobForFamilyWording', () => {
  test('reads the live athlete row in this organization, as a calendar day', async () => {
    mockQueryOne.mockResolvedValueOnce({ dob: '2012-03-01' });
    expect(await readAthleteDobForFamilyWording('org-1', 'ath-1')).toBe('2012-03-01');
    const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    const text = sql.replace(/\s+/g, ' ');
    expect(text).toContain("to_char(dob, 'YYYY-MM-DD') as dob");
    expect(text).toContain('organization_id = $1 and athlete_id = $2 and deleted_at is null');
    expect(params).toEqual(['org-1', 'ath-1']);
  });

  test('no row or no dob reads as null (a minor)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await readAthleteDobForFamilyWording('org-1', 'ath-1')).toBeNull();
    mockQueryOne.mockResolvedValueOnce({ dob: null });
    expect(await readAthleteDobForFamilyWording('org-1', 'ath-1')).toBeNull();
  });
});
