jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('./guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
  guardianParentIds: jest.fn(),
}));

jest.mock('./intake', () => ({
  upsertWaiver: jest.fn(),
}));

import { query } from './db';
import { guardianAthleteIds, guardianParentIds } from './guardianAccess';
import { upsertWaiver } from './intake';
import {
  assertGuardianMediaConsent,
  checkGuardianMediaConsent,
  GuardianConsentMissingError,
  grantMediaConsent,
  listConsentForGuardian,
  listOrganizationConsentStatus,
  resolveActingParent,
  withdrawMediaConsent,
} from './guardianConsent';

const mockQuery = jest.mocked(query);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockGuardianParentIds = jest.mocked(guardianParentIds);
const mockUpsertWaiver = jest.mocked(upsertWaiver);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkGuardianMediaConsent', () => {
  test('an athlete with no guardians on file is missing consent, not vacuously ok', async () => {
    mockQuery.mockResolvedValueOnce([]); // guardian_links lookup

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result).toEqual({ ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] });
    // The current-consent query must never run when there are no guardians.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('ok when every linked guardian has a current signed row', async () => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }, { parent_id: 'p2' }]) // guardian_links
      .mockResolvedValueOnce([
        { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
        { parent_id: 'p2', status: 'signed', covers_video: false, public_use_allowed: false, created_at: '2026-08-02T00:00:00Z' },
      ]); // current consent per guardian

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(true);
    expect(result.missingParentIds).toEqual([]);
    expect(result.perGuardian).toHaveLength(2);
  });

  test('missing when one of several guardians has never signed', async () => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }, { parent_id: 'p2' }])
      .mockResolvedValueOnce([
        { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
        // p2 has no row at all.
      ]);

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(false);
    expect(result.missingParentIds).toEqual(['p2']);
  });

  test('withdrawn is treated as missing, not as "used to have consent"', async () => {
    mockQuery
      .mockResolvedValueOnce([{ parent_id: 'p1' }])
      .mockResolvedValueOnce([
        { parent_id: 'p1', status: 'withdrawn', covers_video: true, public_use_allowed: false, created_at: '2026-08-05T00:00:00Z' },
      ]);

    const result = await checkGuardianMediaConsent('org-a', 'ath-1');

    expect(result.ok).toBe(false);
    expect(result.missingParentIds).toEqual(['p1']);
  });

  test('the current-consent query is scoped to organization_id, athlete_id, and waiver_type=photo_media', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([]);

    await checkGuardianMediaConsent('org-a', 'ath-1');

    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toContain('waiver_type = $3');
    expect(params).toEqual(['org-a', 'ath-1', 'photo_media']);
  });
});

describe('assertGuardianMediaConsent', () => {
  test('resolves silently when consent is ok', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([
      { parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' },
    ]);

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).resolves.toBeUndefined();
  });

  test('throws GuardianConsentMissingError naming the missing guardians when consent is not ok', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([]);

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).rejects.toThrow(GuardianConsentMissingError);
  });

  test('the thrown error message says "Blocked"', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }]).mockResolvedValueOnce([]);

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).rejects.toThrow(/Blocked/);
  });

  test('the no-guardians message is distinct from the missing-signature message', async () => {
    mockQuery.mockResolvedValueOnce([]); // no guardians

    await expect(assertGuardianMediaConsent('org-a', 'ath-1')).rejects.toThrow(/no guardians on file/);
  });
});

describe('grantMediaConsent / withdrawMediaConsent', () => {
  test('grant writes a signed photo_media waiver with the given scope', async () => {
    mockUpsertWaiver.mockResolvedValueOnce('waiver-1');

    const id = await grantMediaConsent({
      organizationId: 'org-a',
      athleteId: 'ath-1',
      parentId: 'p1',
      signedByName: 'Jane Guardian',
      coversVideo: true,
      publicUseAllowed: false,
    });

    expect(id).toBe('waiver-1');
    expect(mockUpsertWaiver).toHaveBeenCalledWith(
      expect.objectContaining({
        waiverType: 'photo_media',
        status: 'signed',
        parentId: 'p1',
        signedByRole: 'parent',
        coversVideo: true,
        publicUseAllowed: false,
      }),
    );
  });

  test('withdraw writes a withdrawn photo_media waiver, always with no scope granted', async () => {
    mockUpsertWaiver.mockResolvedValueOnce('waiver-2');

    await withdrawMediaConsent({
      organizationId: 'org-a',
      athleteId: 'ath-1',
      parentId: 'p1',
      signedByName: 'Jane Guardian',
    });

    expect(mockUpsertWaiver).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'withdrawn', coversVideo: false, publicUseAllowed: false }),
    );
  });
});

describe('resolveActingParent', () => {
  test('resolves the caller\'s own parent_id and full_name', async () => {
    mockGuardianParentIds.mockResolvedValueOnce(['p1']);
    mockQuery.mockResolvedValueOnce([{ full_name: 'Jane Guardian' }]);

    const result = await resolveActingParent('org-a', 'acct-parent');

    expect(result).toEqual({ parentId: 'p1', fullName: 'Jane Guardian' });
  });

  test('null when the account backs no parent row', async () => {
    mockGuardianParentIds.mockResolvedValueOnce([]);

    const result = await resolveActingParent('org-a', 'acct-parent');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('listConsentForGuardian', () => {
  test('returns consent status for every athlete this account guards', async () => {
    mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1', 'ath-2']);
    // listConsentForGuardian runs checkGuardianMediaConsent for every athlete
    // CONCURRENTLY (Promise.all), so a positional mockResolvedValueOnce
    // queue cannot predict which athlete's call consumes which queued
    // value -- the mock has to branch on the call's own arguments instead.
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const athleteId = params[1];
      if (String(sql).includes('guardian_links')) {
        return [{ parent_id: 'p1' }];
      }
      // The current-consent (pilot.waivers) query.
      if (athleteId === 'ath-1') return []; // never signed -> missing
      return [{ parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }];
    });

    const result = await listConsentForGuardian('org-a', 'acct-parent');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ athleteId: 'ath-1', consent: expect.objectContaining({ ok: false }) });
    expect(result[1]).toMatchObject({ athleteId: 'ath-2', consent: expect.objectContaining({ ok: true }) });
  });
});

describe('listOrganizationConsentStatus', () => {
  test('returns every athlete in the org with a consent breakdown, including zero-guardian athletes', async () => {
    mockQuery
      .mockResolvedValueOnce([{ athlete_id: 'ath-1', full_name: 'Sample Athlete' }]) // athletes list
      .mockResolvedValueOnce([]); // guardian_links for ath-1: none

    const result = await listOrganizationConsentStatus('org-a');

    expect(result).toEqual([
      { athleteId: 'ath-1', athleteName: 'Sample Athlete', consent: { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] } },
    ]);
  });
});
