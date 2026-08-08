import { NextRequest } from 'next/server';

import { GET } from './route';
import { listOrganizationConsentStatus } from '@/src/server/pilot/guardianConsent';
import { requirePrincipal } from '@/src/server/pilot/http';

// GuardianConsentMissingError is preserved (not replaced) because http.ts's
// own jsonError does `error instanceof GuardianConsentMissingError` against
// THIS module -- a full mock without it makes that instanceof check throw.
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    listOrganizationConsentStatus: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
  };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listOrganizationConsentStatus);

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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/admin/athlete-consent', () => {
  test('an organization admin sees the org-wide consent audit, including zero-guardian athletes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([
      {
        athleteId: 'ath-1',
        athleteName: 'Sample Athlete',
        consent: { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] },
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
          per_guardian: [{ parent_id: 'p1', status: 'signed', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' }],
        },
      ],
    });
  });

  test('non-admin roles are refused -- this is an org-admin-only audit', async () => {
    for (const role of ['athlete', 'parent', 'coach', 'board', 'platform_owner']) {
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
