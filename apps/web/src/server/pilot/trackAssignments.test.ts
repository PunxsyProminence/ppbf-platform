import { readAthleteTracks } from './trackAssignments';
import { queryOne } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/db', () => ({ queryOne: jest.fn() }));

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.resetAllMocks();
});

// The gym's map is one jsonb row per organization. An athlete's read must take
// that athlete's entry only, in that athlete's gym, and say nothing the app
// does not know to be a track.
describe('readAthleteTracks', () => {
  test("selects only that athlete's entry, in that athlete's gym", async () => {
    mockQueryOne.mockResolvedValue({ tracks: ['pro'] });

    await readAthleteTracks('org-7', 'ath-9');

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/select assignments -> \$2::text as tracks/);
    expect(sql).toMatch(/from pilot\.admin_track_assignments\s+where organization_id = \$1/);
    // The whole map is never selected: no bare `assignments` column leaves the row.
    expect(sql).not.toMatch(/select\s+assignments\s*(,|from)/);
    expect(params).toEqual(['org-7', 'ath-9']);
  });

  test('returns the stored tracks in the manifest order', async () => {
    mockQueryOne.mockResolvedValue({ tracks: ['collegiate', 'non_contact'] });

    expect(await readAthleteTracks('org-1', 'ath-1')).toEqual(['non_contact', 'collegiate']);
  });

  test('leaves out anything that is not a known track id, and repeats', async () => {
    mockQueryOne.mockResolvedValue({ tracks: ['pro', 'made_up', 7, null, 'pro', { id: 'a2p' }] });

    expect(await readAthleteTracks('org-1', 'ath-1')).toEqual(['pro']);
  });

  test.each([
    ['the gym has no row', null],
    ['the athlete has no entry', { tracks: null }],
    ['the entry is not a list', { tracks: 'pro' }],
    ['the entry is an object', { tracks: { pro: true } }],
    ['the entry is an empty list', { tracks: [] }],
  ])('no tracks when %s: nothing is defaulted', async (_label, row) => {
    mockQueryOne.mockResolvedValue(row);

    expect(await readAthleteTracks('org-1', 'ath-1')).toEqual([]);
  });
});
