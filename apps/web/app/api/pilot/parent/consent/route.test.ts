import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import {
  callerParentIdSet,
  grantMediaConsent,
  listConsentForGuardian,
  resolveActingParent,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { requirePrincipal } from '@/src/server/pilot/http';
import { suppressPublishedMediaForAthlete } from '@/src/server/pilot/publication';

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/publication', () => ({
  suppressPublishedMediaForAthlete: jest.fn(),
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
    callerParentIdSet: jest.fn(),
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
const mockCallerParentIdSet = jest.mocked(callerParentIdSet);
const mockResolveParent = jest.mocked(resolveActingParent);
const mockGrant = jest.mocked(grantMediaConsent);
const mockWithdraw = jest.mocked(withdrawMediaConsent);
const mockGuardianAthleteIds = jest.mocked(guardianAthleteIds);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockSuppress = jest.mocked(suppressPublishedMediaForAthlete);

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
  mockCallerParentIdSet.mockResolvedValue(new Set(['p1']));
  // No published media unless a test says otherwise.
  mockSuppress.mockResolvedValue([]);
});

describe('GET /api/pilot/parent/consent', () => {
  test('a parent sees consent status for their own linked children, with a "you" flag on their own row', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockCallerParentIdSet.mockResolvedValueOnce(new Set(['p1']));
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

  // A guardian of two children via two different pilot.parents rows must
  // see "you" only on the row that is actually theirs -- membership-tested
  // per row against the FULL set of parent_ids they back, not a single
  // "first" pick (the exact bug resolveActingParent used to have).
  test('the "you" flag is membership-tested against every parent_id the caller backs, not just one', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockCallerParentIdSet.mockResolvedValueOnce(new Set(['p1', 'p3']));
    mockList.mockResolvedValueOnce([
      {
        athleteId: 'ath-2',
        consent: {
          ok: false,
          guardianIds: ['p2', 'p3'],
          missingParentIds: ['p2'],
          perGuardian: [
            { parentId: 'p2', status: null, coversVideo: null, publicUseAllowed: null, signedAt: null },
            { parentId: 'p3', status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: '2026-08-01T00:00:00Z' },
          ],
        },
      },
    ]);

    const response = await GET(request('/api/pilot/parent/consent'));
    const body = await response.json();

    expect(body.items[0].per_guardian).toEqual([
      expect.objectContaining({ parent_id: 'p2', you: false }),
      expect.objectContaining({ parent_id: 'p3', you: true }),
    ]);
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
    // resolveActingParent must be athlete-scoped -- the route is only correct
    // because it names which child it's acting for, not just which account.
    expect(mockResolveParent).toHaveBeenCalledWith('org-a', 'acct-parent', 'ath-1');
  });

  // Round-8 review finding: every existing grant test supplied both
  // covers_video and public_use_allowed explicitly, so the route's own
  // default-derivation (`!== false` / `=== true`) was never actually
  // exercised by an omitted-field request.
  test('grant with covers_video and public_use_allowed omitted defaults to covers_video=true, public_use_allowed=false', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGrant.mockResolvedValueOnce('waiver-3');

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'grant' }));

    expect(response.status).toBe(200);
    expect(mockGrant).toHaveBeenCalledWith(
      expect.objectContaining({ coversVideo: true, publicUseAllowed: false }),
    );
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

  test('withdrawal sweeps the athlete\'s published media and audits each retraction separately', async () => {
    // One guardian's withdrawal invalidates consent; content already
    // published must become non-distributable in the same request, and the
    // withdrawal and each suppression must be independently auditable.
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockWithdraw.mockResolvedValueOnce('waiver-2');
    mockSuppress.mockReset();
    mockSuppress.mockResolvedValueOnce(['pub-1', 'pub-2']);

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'withdraw' }));

    expect(response.status).toBe(200);
    expect(mockSuppress).toHaveBeenCalledWith({
      organizationId: 'org-a',
      athleteId: 'ath-1',
      suppressedByAccountId: 'acct-parent',
      reason: 'guardian_consent_withdrawn',
    });
    const body = (await response.json()) as { retracted_publication_ids?: string[] };
    expect(body.retracted_publication_ids).toEqual(['pub-1', 'pub-2']);
    const auditedActions = mockAudit.mock.calls.map(([event]) => event);
    expect(auditedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'consent_withdrawn', entity_id: 'ath-1' }),
        expect.objectContaining({
          entity_type: 'video_publication',
          entity_id: 'pub-1',
          details: expect.objectContaining({ action: 'publication_retracted_on_consent_withdrawal' }),
        }),
        expect.objectContaining({
          entity_type: 'video_publication',
          entity_id: 'pub-2',
          details: expect.objectContaining({ action: 'publication_retracted_on_consent_withdrawal' }),
        }),
      ]),
    );
  });

  test('a failed sweep surfaces loudly instead of quietly leaving media distributed', async () => {
    // A lost audit row is tolerable; a suppression that did not happen is
    // not. The withdrawal itself already committed, so the response says
    // exactly that and tells the guardian how to retry.
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockWithdraw.mockResolvedValueOnce('waiver-2');
    mockSuppress.mockReset();
    mockSuppress.mockRejectedValueOnce(new Error('deadlock detected'));

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'withdraw' }));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/withdrawal was recorded, but suppressing already-published media failed/);
    // The withdrawal itself still committed and was audited before the sweep.
    expect(mockWithdraw).toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'consent_withdrawn' }));
    // The failure itself is durably audited -- without this row an auditor
    // cannot tell a failed sweep apart from an athlete with no published
    // media.
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'guardian_media_consent',
        entity_id: 'ath-1',
        details: expect.objectContaining({ action: 'consent_withdrawal_suppression_failed' }),
      }),
    );
  });

  test('granting consent sweeps nothing -- re-consent alone republishes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));
    mockGrant.mockResolvedValueOnce('waiver-1');

    const response = await POST(jsonRequest({ athlete_id: 'ath-1', decision: 'grant' }));

    expect(response.status).toBe(200);
    expect(mockSuppress).not.toHaveBeenCalled();
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
