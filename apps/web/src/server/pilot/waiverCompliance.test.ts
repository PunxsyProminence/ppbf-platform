jest.mock('./db', () => ({
  query: jest.fn(),
}));

import { getAthleteWaiverStatus, getOrganizationWaiverStatus, TRACKED_WAIVER_TYPES, WAIVER_STATUSES } from './waiverCompliance';
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

  /* THE ROLLUP AND THE GATE READ THE SAME COLUMN AND MUST AGREE ABOUT IT.

     getAthleteWaiverStatus has had both of these cases covered since it was
     written (see the two tests of the same names below). getOrganizationWaiverStatus
     had neither, and did not normalise -- so the worklist and the gate could
     disagree about the same row. The asymmetry in this file was the asymmetry
     in the module. */
  test('a recognised status survives case and padding, as it does at the gate', async () => {
    // normalizeWaiverStatus's own reasoning: "' Signed ' is a guardian who
    // signed; refusing to take a child to a competition over whitespace
    // punishes the family for a data-entry artifact." The gate honours that.
    // Before this change the rollup did not, so the SAME waiver was valid for
    // competition and reported Missing on the compliance worklist -- and staff
    // would chase a family for a document that is on file and working.
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'general', status: ' Signed ' },
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'travel', status: 'WITHDRAWN' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result[0].waivers.general).toBe('signed');
    expect(result[0].waivers.travel).toBe('withdrawn');
  });

  test('an unrecognised status is missing here too, never passed through raw', async () => {
    // pilot.waivers.status has no CHECK constraint and domain-upsert accepts
    // any client-supplied string, so this is reachable rather than theoretical.
    // 'pending' is a started release, not a given one.
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'general', status: 'pending' },
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'medical_release', status: 'signd' },
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'travel', status: '' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result[0].waivers.general).toBe('missing');
    expect(result[0].waivers.medical_release).toBe('missing');
    expect(result[0].waivers.travel).toBe('missing');
  });

  /* The rollup's answer must be one of the four the type promises, for every
     row. The admin page switches on exactly these and renders anything else
     as 'Missing', so a raw value reaching it is a status rendered by
     accident rather than by decision. */
  test('every value it returns is in the declared vocabulary', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'general', status: 'Approved' },
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'photo_media', status: ' declined' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    for (const value of Object.values(result[0].waivers)) {
      expect(WAIVER_STATUSES).toContain(value);
    }
    expect(result[0].waivers.photo_media).toBe('declined');
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

// The per-athlete narrowing the competition gate reads. It exists so a gate
// can ask about one child without pulling the whole roster's consent state.
describe('getAthleteWaiverStatus', () => {
  test('no row at all is missing -- absence of consent is never a pass', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('missing');
  });

  test('reads one athlete, one type, newest row first -- the append-only rule', async () => {
    mockQuery.mockResolvedValueOnce([{ status: 'signed' }]);

    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('signed');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('pilot.waivers');
    expect(String(sql)).toContain('order by created_at desc');
    expect(String(sql)).toContain('limit 1');
    expect(params).toEqual(['org-1', 'ath-1', 'travel']);
  });

  test('a declined or withdrawn decision is reported as itself, not as missing', async () => {
    mockQuery.mockResolvedValueOnce([{ status: 'declined' }]);
    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('declined');

    mockQuery.mockResolvedValueOnce([{ status: 'withdrawn' }]);
    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('withdrawn');
  });

  // pilot.waivers.status is `text not null` with no check constraint
  // (infra/azure/pilot_slice_postgres.sql), so the column can hold anything a
  // writer puts there. These two pin the deliberately asymmetric handling: a
  // recognised value survives formatting, an unrecognised one fails closed.
  test('a recognised status survives case and padding -- a signature is not lost to whitespace', async () => {
    for (const stored of [' Signed ', 'SIGNED', 'Signed', '\tsigned\n']) {
      mockQuery.mockResolvedValueOnce([{ status: stored }]);
      await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('signed');
    }

    mockQuery.mockResolvedValueOnce([{ status: ' Declined ' }]);
    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('declined');
  });

  test('an unrecognised status is missing, never signed -- unknown input fails closed', async () => {
    // 'pending' and 'partial' are the plausible ones; '' and the typo are the
    // accidents. None of them is a guardian consenting, and 'missing' is the
    // value competitionSafetyGates refuses on.
    for (const stored of ['pending', 'partial', '', '   ', 'sigend', 'unknown']) {
      mockQuery.mockResolvedValueOnce([{ status: stored }]);
      await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).resolves.toBe('missing');
    }
  });

  // Deliberately unlike trainingHolds.ts and access.ts, which swallow 42P01 to
  // degrade to a SAFE pre-migration behaviour. "We could not find out whether a
  // guardian consented" must not degrade to "proceed".
  test('a missing waivers relation is not degraded into a pass', async () => {
    mockQuery.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.waivers" does not exist'), { code: '42P01' }),
    );

    await expect(getAthleteWaiverStatus('org-1', 'ath-1', 'travel')).rejects.toThrow('does not exist');
  });
});
