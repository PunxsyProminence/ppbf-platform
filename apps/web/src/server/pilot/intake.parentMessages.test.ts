jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { listParentMessages } from './intake';
import { query } from './db';

const mockQuery = jest.mocked(query);

afterEach(() => {
  jest.clearAllMocks();
});

describe('listParentMessages', () => {
  test('no athleteIds returns an empty array without querying', async () => {
    const result = await listParentMessages('org-1', []);

    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('filters to note_type parent_message, org-scoped, athlete-scoped', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listParentMessages('org-1', ['ath-1', 'ath-2']);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("co.note_type = 'parent_message'");
    expect(String(sql)).toContain('pilot.coach_observations');
    expect(params).toEqual(['org-1', ['ath-1', 'ath-2']]);
  });

  test('returns sender_role from the joined account, never a resolved name', async () => {
    mockQuery.mockResolvedValueOnce([
      { note_id: 'note-1', athlete_id: 'ath-1', sender_role: 'coach', note_text: 'Great week!', created_at: '2026-08-07T00:00:00.000Z' },
    ]);

    const result = await listParentMessages('org-1', ['ath-1']);

    expect(result).toEqual([
      { note_id: 'note-1', athlete_id: 'ath-1', sender_role: 'coach', note_text: 'Great week!', created_at: '2026-08-07T00:00:00.000Z' },
    ]);
  });

  test('most recent message first', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listParentMessages('org-1', ['ath-1']);

    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('order by co.created_at desc');
  });
});
