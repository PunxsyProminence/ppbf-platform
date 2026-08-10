jest.mock('./db', () => ({
  query: jest.fn(),
}));

import { getOrganizationWaiverStatus, TRACKED_WAIVER_TYPES } from './waiverCompliance';
import { query } from './db';

const mockQuery = jest.mocked(query);

afterEach(() => {
  jest.clearAllMocks();
});

describe('getOrganizationWaiverStatus', () => {
  test('an athlete with no waiver rows at all reads every tracked type as missing', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: null, status: null },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result).toEqual([
      {
        athleteId: 'ath-1',
        athleteName: 'Jordan T.',
        activeFlag: true,
        waivers: { general: 'missing', medical_release: 'missing', photo_media: 'missing', travel: 'missing' },
      },
    ]);
  });

  // The LEFT JOIN LATERAL produces one row per (athlete, waiver_type) that
  // actually has a row -- multiple rows collapse back into one athlete
  // entry, and types with no row at all stay 'missing'.
  test('multiple waiver-type rows for the same athlete collapse into one entry', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'general', status: 'signed' },
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'photo_media', status: 'withdrawn' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result).toHaveLength(1);
    expect(result[0].waivers).toEqual({
      general: 'signed',
      medical_release: 'missing',
      photo_media: 'withdrawn',
      travel: 'missing',
    });
  });

  test('a declined waiver reads as declined, not missing -- a decision was made, and it was no', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'medical_release', status: 'declined' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result[0].waivers.medical_release).toBe('declined');
  });

  test('multiple athletes are each their own entry', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'general', status: 'signed' },
      { athlete_id: 'ath-2', full_name: 'Sam R.', active_flag: false, waiver_type: null, status: null },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result.map((r) => r.athleteId)).toEqual(['ath-1', 'ath-2']);
    expect(result[1].activeFlag).toBe(false);
  });

  test('queries only the tracked waiver-type vocabulary, org-scoped', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getOrganizationWaiverStatus('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('pilot.waivers');
    expect(params).toEqual(['org-1', TRACKED_WAIVER_TYPES]);
  });

  test('no athletes at all returns an empty array', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(getOrganizationWaiverStatus('org-1')).resolves.toEqual([]);
  });
});
