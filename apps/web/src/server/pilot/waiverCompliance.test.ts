jest.mock('./db', () => ({
  query: jest.fn(),
}));

/* The media consent check is the one read this module does not make itself
   (see MEDIA_CONSENT_TRACKED_TYPE). Mocked whole: the real module imports
   this one, and the point here is what the rollup does with the answer. */
jest.mock('./guardianConsent', () => ({
  checkGuardianMediaConsent: jest.fn(),
  MEDIA_CONSENT_WAIVER_TYPE: jest.requireActual('./guardianConsent').MEDIA_CONSENT_WAIVER_TYPE,
}));

import fs from 'node:fs';
import path from 'node:path';

import {
  getAthleteWaiverStatus,
  getOrganizationWaiverStatus,
  MEDIA_CONSENT_TRACKED_TYPE,
  mediaConsentAsWaiverStatus,
  requireWaiverStatus,
  TRACKED_WAIVER_TYPES,
  WAIVER_STATUSES,
  type WaiverStatus,
} from './waiverCompliance';
import { query } from './db';
import { checkGuardianMediaConsent, MEDIA_CONSENT_WAIVER_TYPE, type ConsentCheckResult } from './guardianConsent';

const mockQuery = jest.mocked(query);
const mockMediaConsent = jest.mocked(checkGuardianMediaConsent);

/** A consent answer with no guardians at all: the check's "unverifiable". */
const NO_GUARDIANS: ConsentCheckResult = { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [], retained: [] };

function guardian(status: string | null, parentId = 'p1') {
  return { parentId, status, coversVideo: status === 'signed', publicUseAllowed: false, signedAt: null };
}

beforeEach(() => {
  mockMediaConsent.mockResolvedValue(NO_GUARDIANS);
});

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
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'travel', status: 'withdrawn' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    expect(result).toHaveLength(1);
    expect(result[0].waivers).toEqual({
      general: 'signed',
      medical_release: 'missing',
      photo_media: 'missing',
      travel: 'withdrawn',
    });
  });

  /* PHOTO_MEDIA IS THE CONSENT CHECK'S ANSWER, NOT THE NEWEST ROW (Jason
     2026-10-07, OD-2026-10-07-009). The register form used to file a
     photo_media row with no parent_id, which this rollup read as Signed while
     every media gate -- which reads guardian by guardian -- refused. */
  describe('photo_media', () => {
    test('the row read does not fetch photo_media at all, so a stored register row cannot be read as Signed', async () => {
      mockQuery.mockResolvedValueOnce([
        { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: null, status: null },
      ]);

      await getOrganizationWaiverStatus('org-1');

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(['org-1', ['general', 'medical_release', 'travel']]);
    });

    test('is read through checkGuardianMediaConsent, once per athlete, for this organization', async () => {
      mockQuery.mockResolvedValueOnce([
        { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: null, status: null },
        { athlete_id: 'ath-2', full_name: 'Sam R.', active_flag: true, waiver_type: null, status: null },
      ]);
      mockMediaConsent
        .mockResolvedValueOnce({ ok: true, guardianIds: ['p1'], missingParentIds: [], perGuardian: [guardian('signed')], retained: [] })
        .mockResolvedValueOnce(NO_GUARDIANS);

      const result = await getOrganizationWaiverStatus('org-1');

      expect(mockMediaConsent.mock.calls).toEqual([['org-1', 'ath-1'], ['org-1', 'ath-2']]);
      expect(result[0].waivers.photo_media).toBe('signed');
      expect(result[1].waivers.photo_media).toBe('missing');
    });

    test('a failed consent read fails the rollup rather than falling back to a stored row', async () => {
      mockQuery.mockResolvedValueOnce([
        { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: null, status: null },
      ]);
      mockMediaConsent.mockRejectedValueOnce(new Error('relation does not exist'));

      await expect(getOrganizationWaiverStatus('org-1')).rejects.toThrow('relation does not exist');
    });

    // The two spellings of the waiver type live in two modules on purpose
    // (an import cycle, see MEDIA_CONSENT_TRACKED_TYPE); this is what keeps them equal.
    test('names the same waiver type the consent module does', () => {
      expect(MEDIA_CONSENT_TRACKED_TYPE).toBe(MEDIA_CONSENT_WAIVER_TYPE);
      expect(TRACKED_WAIVER_TYPES).toContain(MEDIA_CONSENT_TRACKED_TYPE);
    });
  });

  describe('mediaConsentAsWaiverStatus', () => {
    const cases: Array<[string, ConsentCheckResult, WaiverStatus]> = [
      ['ok is signed', { ok: true, guardianIds: ['p1'], missingParentIds: [], perGuardian: [guardian('signed')], retained: [] }, 'signed'],
      // A photo-only consent is still a signed one here; /parent/safety has
      // the extra word for it, this worklist does not.
      ['ok with photo-only is still signed', { ok: true, guardianIds: ['p1'], missingParentIds: [], perGuardian: [{ ...guardian('signed'), coversVideo: false }], retained: [] }, 'signed'],
      ['no guardians is missing, never signed', NO_GUARDIANS, 'missing'],
      ['a guardian with nothing on file is missing', { ok: false, guardianIds: ['p1'], missingParentIds: ['p1'], perGuardian: [guardian(null)], retained: [] }, 'missing'],
      ['one signed, one unanswered is missing -- consent is not on file', { ok: false, guardianIds: ['p1', 'p2'], missingParentIds: ['p2'], perGuardian: [guardian('signed'), guardian(null, 'p2')], retained: [] }, 'missing'],
      ['a withdrawal outranks a signature from the other guardian', { ok: false, guardianIds: ['p1', 'p2'], missingParentIds: ['p2'], perGuardian: [guardian('signed'), guardian('withdrawn', 'p2')], retained: [] }, 'withdrawn'],
      ['a withdrawal outranks a decline', { ok: false, guardianIds: ['p1', 'p2'], missingParentIds: ['p1', 'p2'], perGuardian: [guardian('declined'), guardian('withdrawn', 'p2')], retained: [] }, 'withdrawn'],
      ['a decline reads as declined', { ok: false, guardianIds: ['p1'], missingParentIds: ['p1'], perGuardian: [guardian('declined')], retained: [] }, 'declined'],
      // A purged former guardian's "no" is kept (Jason 2026-10-05) and is what
      // every media gate reads; "missing" would say the gym holds no form.
      ['a retained withdrawal from a purged guardian reads as withdrawn', { ok: false, guardianIds: ['p1'], missingParentIds: [], perGuardian: [guardian('signed')], retained: [guardian('withdrawn', 'former')] }, 'withdrawn'],
      ['statuses are normalised the way the gates normalise them', { ok: false, guardianIds: ['p1'], missingParentIds: ['p1'], perGuardian: [guardian(' Declined ')], retained: [] }, 'declined'],
      ['an unrecognised status is missing, never signed', { ok: false, guardianIds: ['p1'], missingParentIds: ['p1'], perGuardian: [guardian('pending')], retained: [] }, 'missing'],
    ];

    test.each(cases)('%s', (_name, consent, expected) => {
      expect(mediaConsentAsWaiverStatus(consent)).toBe(expected);
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
    // pilot.waivers.status had no CHECK constraint and domain-upsert accepted
    // any client-supplied string, so this was reachable rather than theoretical.
    // pilot_waivers_status_check and requireWaiverStatus refuse such values on
    // write now; rows written before them, or on a database the migration has
    // not reached, can still hold them.
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
      { athlete_id: 'ath-1', full_name: 'Jordan T.', active_flag: true, waiver_type: 'travel', status: ' declined' },
    ]);

    const result = await getOrganizationWaiverStatus('org-1');

    for (const value of Object.values(result[0].waivers)) {
      expect(WAIVER_STATUSES).toContain(value);
    }
    expect(result[0].waivers.travel).toBe('declined');
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

  test('queries only the row-read tracked waiver-type vocabulary, org-scoped', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getOrganizationWaiverStatus('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('pilot.waivers');
    expect(params).toEqual(['org-1', TRACKED_WAIVER_TYPES.filter((type) => type !== 'photo_media')]);
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

  // pilot.waivers.status was `text not null` with no check constraint
  // (infra/azure/pilot_slice_postgres.sql) until pilot_waivers_status_check, so
  // rows written before it, or on a database the migration has not reached, can
  // hold anything a writer put there. These two pin the deliberately
  // asymmetric handling: a recognised value survives formatting, an
  // unrecognised one fails closed.
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

/* requireWaiverStatus is what domain-upsert and review-action check a
   caller's status against before writing it. pilot_waivers_status_check is
   the floor under it, so the two must admit exactly the same set -- a value
   this admits and the constraint refuses surfaces as a 500 again, and one the
   constraint admits and this refuses is a working status nobody can file. */
describe('requireWaiverStatus', () => {
  test.each([...WAIVER_STATUSES])('accepts %p exactly', (status) => {
    expect(requireWaiverStatus(status, 'payload.status')).toBe(status);
  });

  test.each([' Signed ', 'SIGNED', 'Signed', 'signed ', '', 'pending', 'active'])(
    'refuses %p with a 400-class error naming the field',
    (status) => {
      expect(() => requireWaiverStatus(status, 'payload.status')).toThrow(
        'Unsupported payload.status: must be exactly one of signed, declined, withdrawn, missing',
      );
    },
  );

  test.each([
    ['null', null],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { status: 'signed' }],
    ['an array', ['signed']],
  ])('refuses %s rather than treating it as absent', (_label, value) => {
    expect(() => requireWaiverStatus(value, 'payload.status', 'signed')).toThrow(/^Unsupported payload\.status/);
  });

  test('the fallback applies only when the field is absent', () => {
    expect(requireWaiverStatus(undefined, 'payload.status', 'signed')).toBe('signed');
  });

  test('with no fallback, absence is refused', () => {
    expect(() => requireWaiverStatus(undefined, 'promotion.waiver.status')).toThrow(
      /^Unsupported promotion\.waiver\.status/,
    );
  });

  test('the database CHECK names exactly the same four values', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres_waiver_status_check_migration.sql'),
      'utf8',
    );
    const check = sql.match(/check \(status in \(([^)]*)\)\)/);
    expect(check).not.toBeNull();
    const literals = [...(check?.[1] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]);
    expect(literals).toEqual([...WAIVER_STATUSES]);
  });
});
