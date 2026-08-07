import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import {
  grantMediaConsent,
  listConsentForGuardian,
  resolveActingParent,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

// GuardianConsentMissingError is preserved (not replaced) because http.ts's
// own jsonError does `error instanceof GuardianConsentMissingError` against
// THIS module -- a full mock without it makes that instanceof check throw.
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    grantMediaConsent: jest.fn(),
    withdrawMediaConsent: jest.fn(),
    listConsentForGuardian: jest.fn(),
    resolveActingParent: jest.fn(),
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
const mockList = jest.mocked(listConsentForGuardian);
const mockResolveParent = jest.mocked(resolveActingParent);
const mockGrant = jest.mocked(grantMediaConsent);
const mockWithdraw = jest.mocked(withdrawMediaConsent);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-parent',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function request(url: string): NextRequest {
  return new NextRequest(`https://ppbf.example${url}`);
}

function jsonRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/parent/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuardianAthleteIds.mockResolvedValue(['ath-1']);
  mockResolveParent.mockResolvedValue({ parentId: 'p1', fullName: 'Jane Guardian' });
});

describe('GET /api/pilot/parent/consent', () => {
  test('a parent sees consent status for their own linked children, with a "you" flag on their own row', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockList.mockResolvedValueOnce([
      {
        athleteId: 'ath-1',
        consent: {
          ok: true,
          guardianIds: ['p1'],
          missingParentIds: [],
          perGuardian: [{ parentId: 'p1', status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: '2026-08-01T00:00:00Z' }],
        },
      },
    ]);

    const response = await GET(request('/api/pilot/parent/consent'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      items: [
        {
          athlete_id: 'ath-1',
          consent_ok: true,
          guardian_count: 1,
          missing_guardian_count: 0,
          per_guardian: [
            { parent_id: 'p1', you: true, status: 'signed', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' },
          ],
        },
      ],
    });
  });

  test('non-parent roles are refused', async () => {
    for (const role of ['athlete', 'coach', 'admin', 'organization_admin', 'board']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/parent/consent'));
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/parent/consent', () => {
  test('grant writes consent for the caller\'s own linked athlete and audits it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGrant.mockResolvedValueOnce('waiver-1');

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'grant', covers_video: true, public_use_allowed: false }));

    expect(response.status).toBe(200);
    expect(mockGrant).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1', signedByName: 'Jane Guardian', coversVideo: true, publicUseAllowed: false }),
    );
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'consent_granted', entity_id: 'ath-1' }));
  });

  test('withdraw writes consent withdrawal and audits it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockWithdraw.mockResolvedValueOnce('waiver-2');

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'withdraw' }));

    expect(response.status).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', athleteId: 'ath-1', parentId: 'p1' }),
    );
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'consent_withdrawn', entity_id: 'ath-1' }));
  });

  // The whole reason for this route to check guardianAthleteIds itself:
  // a caller-supplied athlete_id being well-formed proves nothing about
  // whose child it is.
  test('a parent cannot act on an athlete they do not guard -- hidden 404, not a 403 that would confirm the athlete exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGuardianAthleteIds.mockResolvedValueOnce(['ath-1']); // caller guards only ath-1

    const response = await POST(jsonRequest({ athlete_id: 'ath-not-mine', decision: 'grant' }));

    expect(response.status).toBe(404);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockResolveParent).not.toHaveBeenCalled();
  });

  test('missing athlete_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));

    const response = await POST(jsonRequest({ decision: 'grant' }));

    expect(response.status).toBe(400);
    expect(mockGuardianAthleteIds).not.toHaveBeenCalled();
  });

  test('an unrecognized decision is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'revoke' }));

    expect(response.status).toBe(400);
  });

  test('non-parent roles are refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'grant' }));

    expect(response.status).toBe(403);
    expect(mockGuardianAthleteIds).not.toHaveBeenCalled();
  });

  test('a failed audit write does not fail the request -- the consent write already committed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGrant.mockResolvedValueOnce('waiver-1');
    mockAudit.mockRejectedValueOnce(Object.assign(new Error('insert failed'), { code: '23514' }));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'grant' }));

    expect(response.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'guardian-consent-audit-write-failed' }),
    );
    consoleErrorSpy.mockRestore();
  });
});
