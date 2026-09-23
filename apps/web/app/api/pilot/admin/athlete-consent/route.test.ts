import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  checkGuardianMediaConsent,
  grantMediaConsent,
  listOrganizationConsentStatus,
  listOrganizationGuardianNames,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { suppressPublishedMediaForAthlete } from '@/src/server/pilot/publication';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';

// GuardianConsentMissingError is preserved (not replaced) because http.ts's
// own jsonError does `error instanceof GuardianConsentMissingError` against
// THIS module -- a full mock without it makes that instanceof check throw.
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    listOrganizationConsentStatus: jest.fn(),
    listOrganizationGuardianNames: jest.fn(),
    checkGuardianMediaConsent: jest.fn(),
    grantMediaConsent: jest.fn(),
    withdrawMediaConsent: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/access', () => ({ assertActorCanAccessAthlete: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/publication', () => ({ suppressPublishedMediaForAthlete: jest.fn() }));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listOrganizationConsentStatus);
const mockGuardianNames = jest.mocked(listOrganizationGuardianNames);
const mockCheckConsent = jest.mocked(checkGuardianMediaConsent);
const mockGrant = jest.mocked(grantMediaConsent);
const mockWithdraw = jest.mocked(withdrawMediaConsent);
const mockAccess = jest.mocked(assertActorCanAccessAthlete);
const mockSuppress = jest.mocked(suppressPublishedMediaForAthlete);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function request(): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/athlete-consent');
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/athlete-consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const GRANT_BODY = { athlete_id: 'ath-1', parent_id: 'p1', decision: 'grant' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue(undefined);
  mockCheckConsent.mockResolvedValue({
    ok: false,
    guardianIds: ['p1', 'p2'],
    missingParentIds: ['p1', 'p2'],
    perGuardian: [],
  });
  mockGuardianNames.mockResolvedValue(new Map([['p1', 'Dana Reyes']]));
  mockGrant.mockResolvedValue('wv-1');
  mockWithdraw.mockResolvedValue('wv-2');
  mockSuppress.mockResolvedValue([]);
  mockAudit.mockResolvedValue(undefined as never);
});

describe('GET /api/pilot/admin/athlete-consent', () => {
  test('an organization admin sees the org-wide consent audit, including zero-guardian athletes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([
      {
        athleteId: 'ath-1',
        athleteName: 'Sample Athlete',
        consent: { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] },
        guardians: [],
      },
      {
        athleteId: 'ath-2',
        athleteName: 'Other Athlete',
        consent: {
          ok: true,
          guardianIds: ['p1'],
          missingParentIds: [],
          perGuardian: [{ parentId: 'p1', status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: '2026-08-01T00:00:00Z' }],
        },
        guardians: [{ parentId: 'p1', fullName: 'Dana Reyes' }],
      },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      items: [
        { athlete_id: 'ath-1', athlete_name: 'Sample Athlete', consent_ok: false, guardian_count: 0, missing_guardian_count: 0, per_guardian: [] },
        {
          athlete_id: 'ath-2',
          athlete_name: 'Other Athlete',
          consent_ok: true,
          guardian_count: 1,
          missing_guardian_count: 0,
          per_guardian: [
            {
              parent_id: 'p1',
              parent_name: 'Dana Reyes',
              status: 'signed',
              covers_video: true,
              public_use_allowed: false,
              signed_at: '2026-08-01T00:00:00Z',
            },
          ],
        },
      ],
    });
  });

  test('a coach reaches the audit -- they record consent from it, so they must be able to read it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockList.mockResolvedValueOnce([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a');
  });

  test('roles with no business on the roster are still refused', async () => {
    for (const role of ['athlete', 'parent', 'board', 'platform_owner']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request());
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  test('the legacy admin role name also works', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockList.mockResolvedValueOnce([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
  });
});

describe('POST /api/pilot/admin/athlete-consent -- role gate', () => {
  test('admin, organization_admin and coach may all record a signature', async () => {
    for (const role of ['admin', 'organization_admin', 'coach']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await POST(jsonRequest(GRANT_BODY));
      expect(response.status).toBe(200);
    }
    expect(mockGrant).toHaveBeenCalledTimes(3);
  });

  test('everyone else is refused and nothing is written', async () => {
    for (const role of ['athlete', 'parent', 'board', 'platform_owner']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await POST(jsonRequest(GRANT_BODY));
      expect(response.status).toBe(403);
    }
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/athlete-consent -- validation', () => {
  test.each([
    ['missing athlete_id', { parent_id: 'p1', decision: 'grant' }],
    ['missing parent_id', { athlete_id: 'ath-1', decision: 'grant' }],
    ['an unsupported decision', { ...GRANT_BODY, decision: 'revoke' }],
    ['covers_video sent as the STRING "false"', { ...GRANT_BODY, covers_video: 'false' }],
    ['covers_video sent as null', { ...GRANT_BODY, covers_video: null }],
    ['an unparseable signed_at', { ...GRANT_BODY, signed_at: 'not-a-date' }],
    ['notes sent as a number', { ...GRANT_BODY, notes: 42 }],
  ])('%s is a 400 and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest(body));

    expect(response.status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/athlete-consent -- authorization', () => {
  test('a coach who is not assigned to the athlete is refused, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(jsonRequest(GRANT_BODY));

    expect(response.status).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('a parent_id that does not guard this athlete is a 404, not a 403 -- and writes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockCheckConsent.mockResolvedValueOnce({
      ok: false,
      guardianIds: ['someone-else'],
      missingParentIds: ['someone-else'],
      perGuardian: [],
    });

    const response = await POST(jsonRequest(GRANT_BODY));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    expect(mockGrant).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/athlete-consent -- the write', () => {
  test('covers_video omitted records TRUE -- the default is enforced at the API, not only in the form', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest(GRANT_BODY));

    expect(response.status).toBe(200);
    expect(mockGrant).toHaveBeenCalledWith(
      expect.objectContaining({ coversVideo: true, publicUseAllowed: false, parentId: 'p1', signedByName: 'Dana Reyes' }),
    );
  });

  test('covers_video false is forwarded as false', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    await POST(jsonRequest({ ...GRANT_BODY, covers_video: false }));

    expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({ coversVideo: false }));
  });

  test('a grant over a standing withdrawal is an ordinary write -- the route has no reversal guard', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockCheckConsent.mockResolvedValueOnce({
      ok: false,
      guardianIds: ['p1'],
      missingParentIds: ['p1'],
      perGuardian: [{ parentId: 'p1', status: 'withdrawn', coversVideo: false, publicUseAllowed: false, signedAt: '2026-08-01T00:00:00Z' }],
    });

    const response = await POST(jsonRequest(GRANT_BODY));

    expect(response.status).toBe(200);
    expect(mockGrant).toHaveBeenCalledTimes(1);
  });

  test('signed_at is forwarded verbatim when supplied and undefined when omitted', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    await POST(jsonRequest({ ...GRANT_BODY, signed_at: '2026-03-04T12:00:00.000Z' }));
    expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({ signedAt: '2026-03-04T12:00:00.000Z' }));

    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    await POST(jsonRequest(GRANT_BODY));
    expect(mockGrant).toHaveBeenLastCalledWith(expect.objectContaining({ signedAt: undefined }));
  });

  test('the waiver id reaches the response body', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest(GRANT_BODY));

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true, waiver_id: 'wv-1', decision: 'grant', parent_id: 'p1' }),
    );
  });

  test('withdraw calls the withdrawal writer and not the grant writer', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(response.status).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledTimes(1);
    expect(mockGrant).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/athlete-consent -- audit and the withdrawal sweep', () => {
  test('a grant writes one consent_granted event carrying who entered it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    await POST(jsonRequest(GRANT_BODY));

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'consent_granted',
        entity_type: 'guardian_media_consent',
        entity_id: 'ath-1',
        actor_role: 'coach',
        actor_account_id: 'acct-admin',
      }),
    );
  });

  test('a lost audit row does not tell the caller their write failed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAudit.mockRejectedValue(new Error('audit table unavailable'));

    const response = await POST(jsonRequest(GRANT_BODY));

    expect(response.status).toBe(200);
    expect(mockGrant).toHaveBeenCalledTimes(1);
  });

  test('a staff-recorded withdrawal retracts published media, exactly as a guardian withdrawal does', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSuppress.mockResolvedValueOnce(['pub-1', 'pub-2']);

    const response = await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(response.status).toBe(200);
    expect(mockSuppress).toHaveBeenCalledWith(
      expect.objectContaining({ athleteId: 'ath-1', reason: 'guardian_consent_withdrawn' }),
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ retracted_publication_ids: ['pub-1', 'pub-2'] }),
    );
  });

  test('a failed sweep surfaces as a 500 -- the withdrawal committed, the safety action did not', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSuppress.mockRejectedValueOnce(new Error('suppression failed'));

    const response = await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(response.status).toBe(500);
    expect(mockWithdraw).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});
