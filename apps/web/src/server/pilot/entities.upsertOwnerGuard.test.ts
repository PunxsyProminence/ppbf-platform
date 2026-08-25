import { query } from './db';
import { upsertGoal, upsertSession } from './entities';
import { ConflictError } from './errors';
import type { PilotGoal, PilotSession } from './contracts';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;

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

    await upsertSession('org-1', session({ athlete_id: 'ath-new' }), { mode: 'update', expectedAthleteId: 'ath-owner' });

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
      upsertSession('org-1', session(), { mode: 'update', expectedAthleteId: 'ath-owner' }),
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
