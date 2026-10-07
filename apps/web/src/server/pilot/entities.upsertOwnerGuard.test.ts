import { query, queryOne } from './db';
import { upsertCoachReview, upsertGoal, upsertSession } from './entities';
import { ConflictError, ForbiddenError } from './errors';
import type { PilotCoachReview, PilotGoal, PilotSession } from './contracts';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

function session(overrides: Partial<PilotSession> = {}): PilotSession {
  return {
    session_id: 'sess-1',
    athlete_id: 'ath-1',
    date: '2026-08-25',
    rpe: null,
    rpe_method: 'UNKNOWN',
    notes: 'felt strong',
    completed_flag: false,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
    ...overrides,
  };
}

function goal(overrides: Partial<PilotGoal> = {}): PilotGoal {
  return {
    goal_id: 'goal-1',
    athlete_id: 'ath-1',
    title: 'Land the jab',
    target_date: '2026-12-01',
    metric: 'reps',
    status: 'Active',
    category: 'Boxing',
    progress_percent: 0,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
    ...overrides,
  } as PilotGoal;
}

afterEach(() => {
  jest.clearAllMocks();
});

// The whole point of the guard: the authorization check and the write are the
// same statement, so a row that appears or changes owner between the route's
// lookup and this write cannot be silently overwritten (TOCTOU).
describe('upsertSession — write owner guard', () => {
  test("create mode is INSERT ... ON CONFLICT DO NOTHING, never an update", async () => {
    mockQuery.mockResolvedValueOnce([{ session_id: 'sess-1' }]);

    await upsertSession('org-1', session(), { mode: 'create' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.sessions');
    expect(sql).toContain('on conflict (organization_id, session_id) do nothing');
    expect(sql).not.toContain('update pilot.sessions');
  });

  test('create mode fails closed when the id appeared concurrently (0 rows inserted)', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(upsertSession('org-1', session(), { mode: 'create' })).rejects.toBeInstanceOf(ConflictError);
    // It must NOT fall through to an UPDATE that would rewrite the row that appeared.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("update mode carries the expected owner in the WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce([{ session_id: 'sess-1' }]);

    await upsertSession('org-1', session({ athlete_id: 'ath-new' }), { mode: 'update', expectedAthleteId: 'ath-owner', noteWriter: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('update pilot.sessions');
    expect(sql).toMatch(/where organization_id = \$1 and session_id = \$2 and athlete_id = \$10/);
    // The reassignment target ($3) and the authorized current owner ($10) are distinct.
    expect(params[2]).toBe('ath-new');
    expect(params[9]).toBe('ath-owner');
  });

  test('update mode fails closed when the owner changed concurrently (0 rows updated)', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(
      upsertSession('org-1', session(), { mode: 'update', expectedAthleteId: 'ath-owner', noteWriter: true }),
    ).rejects.toBeInstanceOf(ConflictError);
    // The writer's own write needs no follow-up read to explain a miss.
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  // OD-2026-10-06-025 ruling 4: only the writer changes a session note. The
  // rule lives in the UPDATE's WHERE so it holds in the same statement as the
  // write, not in a read that a concurrent writer could get between.
  test('update mode carries the note-writer guard in the WHERE clause', async () => {
    mockQuery.mockResolvedValueOnce([{ session_id: 'sess-1' }]);

    await upsertSession('org-1', session({ notes: 'rewritten' }), { mode: 'update', expectedAthleteId: 'ath-owner', noteWriter: false });

    const [sql, params] = mockQuery.mock.calls[0];
    // Text unchanged (ends-trimmed) AND the session stays with its athlete:
    // a move would hand the note to a new "writer".
    expect(sql).toMatch(/and \(\$13::boolean or \(btrim\(notes\) = \$7 and \$3 = \$10\)\)/);
    // A non-writer's SET never touches the stored bytes of the note.
    expect(sql).toMatch(/notes = case when \$13::boolean then \$7 else notes end/);
    expect(params[6]).toBe('rewritten');
    expect(params[12]).toBe(false);
  });

  test('a non-writer who moves the session to another athlete is refused with a 403', async () => {
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ notes: 'felt strong' });

    await expect(
      upsertSession('org-1', session({ athlete_id: 'ath-other' }), { mode: 'update', expectedAthleteId: 'ath-1', noteWriter: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('a non-writer whose text differs from the stored note is refused with a 403, not a 409', async () => {
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ notes: 'the athlete wrote this' });

    await expect(
      upsertSession('org-1', session({ notes: 'rewritten' }), { mode: 'update', expectedAthleteId: 'ath-1', noteWriter: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // The follow-up read is scoped to the authorized owner's row.
    const [, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['org-1', 'sess-1', 'ath-1']);
  });

  test('a non-writer whose miss is not about the note gets the ordinary conflict', async () => {
    mockQuery.mockResolvedValueOnce([]);
    // Stored with stray spaces, as an older row may be; the validator trims
    // what the caller sent, so the comparison ignores the ends.
    mockQueryOne.mockResolvedValueOnce({ notes: '  rewritten ' });

    await expect(
      upsertSession('org-1', session({ notes: 'rewritten' }), { mode: 'update', expectedAthleteId: 'ath-1', noteWriter: false }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('upsertGoal — write owner guard', () => {
  test("create mode is INSERT ... ON CONFLICT DO NOTHING, never an update", async () => {
    mockQuery.mockResolvedValueOnce([{ goal_id: 'goal-1' }]);

    await upsertGoal('org-1', goal(), { mode: 'create' });

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.goals');
    expect(sql).toContain('on conflict (organization_id, goal_id) do nothing');
    expect(sql).not.toContain('update pilot.goals');
  });

  test('create mode fails closed when the id appeared concurrently', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(upsertGoal('org-1', goal(), { mode: 'create' })).rejects.toBeInstanceOf(ConflictError);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("update mode carries the expected owner in the WHERE clause", async () => {
    mockQuery.mockResolvedValueOnce([{ goal_id: 'goal-1' }]);

    await upsertGoal('org-1', goal({ athlete_id: 'ath-new' }), { mode: 'update', expectedAthleteId: 'ath-owner' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('update pilot.goals');
    expect(sql).toMatch(/where organization_id = \$1 and goal_id = \$2 and athlete_id = \$11/);
    expect(params[2]).toBe('ath-new');
    expect(params[10]).toBe('ath-owner');
  });

  test('update mode fails closed when the owner changed concurrently', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(
      upsertGoal('org-1', goal(), { mode: 'update', expectedAthleteId: 'ath-owner' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});


describe('upsertCoachReview — write owner guard (coach_reviews own via session)', () => {
  function review(overrides: Partial<PilotCoachReview> = {}): PilotCoachReview {
    return {
      review_id: 'rev-1',
      session_id: 'sess-1',
      coach_id: 'coach-1',
      decision: 'approve',
      notes: 'cleared to spar',
      approved_flag: true,
      created_at: '2026-08-25T00:00:00Z',
      updated_at: '2026-08-25T00:00:00Z',
      ...overrides,
    };
  }

  test('create mode is INSERT ... ON CONFLICT DO NOTHING, never an UPDATE', async () => {
    mockQuery.mockResolvedValueOnce([{ review_id: 'rev-1' }]);

    await upsertCoachReview('org-1', review(), { mode: 'create' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.coach_reviews');
    expect(sql).toContain('on conflict (organization_id, review_id) do nothing');
    expect(sql).not.toContain('update pilot.coach_reviews');
  });

  // The defect: a coach reusing an existing review_id (another athlete's row) must
  // NOT overwrite it. Create-mode inserts 0 rows and fails closed instead of
  // falling through to an UPDATE.
  test('create mode fails closed when the review id already exists (0 rows inserted)', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(upsertCoachReview('org-1', review(), { mode: 'create' })).rejects.toBeInstanceOf(ConflictError);
    expect(mockQuery).toHaveBeenCalledTimes(1); // no second statement
  });

  test('update mode carries the expected owning session in the WHERE clause', async () => {
    mockQuery.mockResolvedValueOnce([{ review_id: 'rev-1' }]);

    await upsertCoachReview('org-1', review({ session_id: 'sess-new' }), { mode: 'update', expectedSessionId: 'sess-owner' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('update pilot.coach_reviews');
    expect(sql).toMatch(/where organization_id = \$1 and review_id = \$2 and session_id = \$9/);
    // the reassignment target ($3) and the authorized current session ($9) are distinct
    expect(params[2]).toBe('sess-new');
    expect(params[8]).toBe('sess-owner');
  });

  test('update mode fails closed when the row session changed concurrently (0 rows updated)', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(
      upsertCoachReview('org-1', review(), { mode: 'update', expectedSessionId: 'sess-owner' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
