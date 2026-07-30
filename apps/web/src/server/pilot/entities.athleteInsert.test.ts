import { query } from './db';
import { insertAthleteIfAbsent } from './entities';
import type { PilotAthlete } from './contracts';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;

function athlete(overrides: Partial<PilotAthlete> = {}): PilotAthlete {
  return {
    athlete_id: 'ath-new-1',
    full_name: 'Dawn Kellerman',
    dob: '2008-04-17',
    weight_class: '145',
    gym_status: 'active',
    emergency_contact: 'Ruth Kellerman 814-555-0143',
    active_flag: true,
    coach_id: 'coach-1',
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('insertAthleteIfAbsent', () => {
  // The whole point of this helper over "select then upsert": the primary key
  // decides, in one statement, so two concurrent creates for one athlete_id
  // cannot both pass a prior existence check and have the second overwrite
  // the first athlete's record.
  test('writes create-only SQL -- never an "on conflict do update"', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-new-1' }]);

    await insertAthleteIfAbsent('org-1', athlete());

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('on conflict (organization_id, athlete_id) do nothing');
    expect(sql).not.toContain('do update');
  });

  test('reports the conflict instead of reporting a write that did not happen', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(insertAthleteIfAbsent('org-1', athlete({ athlete_id: 'ath-existing-1' }))).resolves.toBe(false);
  });

  test('reports a genuine insert', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-new-1' }]);

    await expect(insertAthleteIfAbsent('org-1', athlete())).resolves.toBe(true);
  });

  test('binds every athlete field as a parameter', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-new-1' }]);

    await insertAthleteIfAbsent('org-1', athlete());

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([
      'org-1',
      'ath-new-1',
      'Dawn Kellerman',
      '2008-04-17',
      '145',
      'active',
      'Ruth Kellerman 814-555-0143',
      true,
      'coach-1',
      '2026-07-29T12:00:00.000Z',
      '2026-07-29T12:00:00.000Z',
    ]);
  });
});
