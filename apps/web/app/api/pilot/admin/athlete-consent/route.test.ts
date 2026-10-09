import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  checkGuardianMediaConsent,
  grantMediaConsent,
  GuardianLinkEndedError,
  guardianDisplayName,
  listOrganizationConsentStatus,
  withdrawMediaConsent,
} from '@/src/server/pilot/guardianConsent';
import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import { recordMediaConsentAndSuppress } from '@/src/server/pilot/publication';
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
    guardianDisplayName: jest.fn(),
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

jest.mock('@/src/server/pilot/access', () => ({ assertAthleteBelongsToOrganization: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/publication', () => ({ recordMediaConsentAndSuppress: jest.fn() }));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listOrganizationConsentStatus);
const mockGuardianName = jest.mocked(guardianDisplayName);
const mockCheckConsent = jest.mocked(checkGuardianMediaConsent);
const mockGrant = jest.mocked(grantMediaConsent);
const mockWithdraw = jest.mocked(withdrawMediaConsent);
const mockAccess = jest.mocked(assertAthleteBelongsToOrganization);
const mockRecord = jest.mocked(recordMediaConsentAndSuppress);

/* recordMediaConsentAndSuppress stands in for the one transaction: the consent
   writer runs with TX, then the takedown (mockSweep, the step that can fail).
   Whether a failure really rolls the consent back is a database question; the
   proof is consentSuppressionAtomic.pg.test.ts. */
const TX = { query: jest.fn() } as never;
const mockSweep = jest.fn<Promise<string[]>, [Record<string, unknown>]>();
function emulateOneTransaction(): void {
  mockRecord.mockImplementation(async ({ write, ...sweepParams }) => {
    const waiverId = await write(TX);
    const publicationIds = await mockSweep(sweepParams);
    return { waiverId, publicationIds };
  });
}
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
  emulateOneTransaction();
  mockAccess.mockResolvedValue(undefined);
  mockCheckConsent.mockResolvedValue({
    ok: false,
    guardianIds: ['p1', 'p2'],
    missingParentIds: ['p1', 'p2'],
    perGuardian: [],
    retained: [],
  });
  mockGuardianName.mockResolvedValue('Dana Reyes');
  mockGrant.mockResolvedValue('wv-1');
  mockWithdraw.mockResolvedValue('wv-2');
  mockSweep.mockResolvedValue([]);
  mockAudit.mockResolvedValue(undefined as never);
});

describe('GET /api/pilot/admin/athlete-consent', () => {
  test('an organization admin sees the org-wide consent audit, including zero-guardian athletes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([
      {
        athleteId: 'ath-1',
        athleteName: 'Sample Athlete',
        consent: { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [], retained: [] },
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
          retained: [],
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
              consented: true,
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
    // V8 rolls this over to March 2; Postgres refuses it. Accepting it would
    // store a different day than the one written on the form.
    ['a signed_at naming a day that does not exist', { ...GRANT_BODY, signed_at: '2026-02-30T12:00:00.000Z' }],
    ['a bare year as signed_at', { ...GRANT_BODY, signed_at: '2026' }],
    ['public_use_allowed sent as the STRING "true"', { ...GRANT_BODY, public_use_allowed: 'true' }],
    ['notes sent as a number', { ...GRANT_BODY, notes: 42 }],
  ])('%s is a 400 and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest(body));

    expect(response.status).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

/**
 * OD-2026-10-07-008: a guardian's consent for an athlete who is 18 or older is
 * refused whoever types it (overwatch 2026-10-08: the staff writer too). This
 * route is where that refusal is normally met, so it is audited here.
 */
describe('POST /api/pilot/admin/athlete-consent -- the guardian link has ended at 18', () => {
  const refusal = () => Promise.reject(new GuardianLinkEndedError());

  test('a direct grant answers 403 GUARDIAN_LINK_ENDED and writes one guardian_link_ended audit row naming the staff actor', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-front-desk' }));
    mockGrant.mockImplementationOnce(refusal);

    const response = await POST(jsonRequest({ ...GRANT_BODY, covers_video: true }));

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain('18 or older; guardian access has ended');
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      actor_account_id: 'acct-front-desk',
      actor_role: 'organization_admin',
      organization_id: 'org-a',
      entity_type: 'guardian_media_consent',
      entity_id: 'ath-1',
      details: { action: 'guardian_link_ended', parent_id: 'p1' },
    }));
  });

  test('a photo-only grant (the sweep path) is the same 403 and single audit row, never a "failed sweep"', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockGrant.mockImplementationOnce(refusal);

    const response = await POST(jsonRequest({ ...GRANT_BODY, covers_video: false }));

    expect(response.status).toBe(403);
    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0].details).toEqual({ action: 'guardian_link_ended', parent_id: 'p1' });
  });

  test('a withdrawal (the other sweep path) is the same 403 and single audit row', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockWithdraw.mockImplementationOnce(refusal);

    const response = await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(response.status).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0].details).toEqual({ action: 'guardian_link_ended', parent_id: 'p1' });
  });
});

describe('POST /api/pilot/admin/athlete-consent -- authorization', () => {
  /*
   * OWNER DECISION: a coach on this route is ORG-WIDE, not scoped to their own
   * assigned athletes. Whoever is handed the paper at the door records it, and
   * the audit beside this writer is itself org-wide -- scoping the write but
   * not the read would offer a coach a button that refuses most of the rows in
   * front of them.
   *
   * So the route must NOT reach for assertActorCanAccessAthlete, whose coach
   * branch narrows to the coach of record plus live coverage grants. This test
   * is what stops that chokepoint being reinstated as an apparent tidy-up.
   */
  test('a coach records for any athlete in their organization, not only their own', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach' }));

    const response = await POST(jsonRequest({ ...GRANT_BODY, athlete_id: 'ath-not-mine' }));

    expect(response.status).toBe(200);
    expect(mockAccess).toHaveBeenCalledWith('org-a', 'ath-not-mine');
    expect(mockGrant).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', athleteId: 'ath-not-mine', recordedByAccountId: 'acct-coach' }),
    );
  });

  test('an athlete outside the caller organization is refused, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockAccess.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));

    const response = await POST(jsonRequest(GRANT_BODY));

    expect(response.status).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('the guardian-membership check is run against THIS athlete and this organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    await POST(jsonRequest(GRANT_BODY));

    expect(mockCheckConsent).toHaveBeenCalledWith('org-a', 'ath-1');
  });

  test('a parent_id that does not guard this athlete is a 404, not a 403 -- and writes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockCheckConsent.mockResolvedValueOnce({
      ok: false,
      guardianIds: ['someone-else'],
      missingParentIds: ['someone-else'],
      perGuardian: [],
      retained: [],
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

    expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({ coversVideo: false }), TX);
  });

  test('public_use_allowed true is forwarded as true -- both halves of the form are recorded', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    await POST(jsonRequest({ ...GRANT_BODY, public_use_allowed: true }));

    expect(mockGrant).toHaveBeenCalledWith(expect.objectContaining({ publicUseAllowed: true }));
  });

  test('the tenant and the actor come from the session, never from the body', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin', { accountId: 'acct-front-desk' }));

    await POST(jsonRequest({ ...GRANT_BODY, organization_id: 'org-somebody-else' }));

    expect(mockGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        athleteId: 'ath-1',
        parentId: 'p1',
        recordedByAccountId: 'acct-front-desk',
      }),
    );
  });

  test('recording a VIDEO consent never retracts anything -- the sweep is for withdrawal and photo-only', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    await POST(jsonRequest(GRANT_BODY));

    expect(mockSweep).not.toHaveBeenCalled();
  });

  test('a grant over a standing withdrawal is an ordinary write -- the route has no reversal guard', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockCheckConsent.mockResolvedValueOnce({
      ok: false,
      guardianIds: ['p1'],
      missingParentIds: ['p1'],
      perGuardian: [{ parentId: 'p1', status: 'withdrawn', coversVideo: false, publicUseAllowed: false, signedAt: '2026-08-01T00:00:00Z' }],
      retained: [],
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

  test('a withdrawal carries the paper date and the filing note too, not only a grant', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-front-desk' }));

    await POST(
      jsonRequest({
        ...GRANT_BODY,
        decision: 'withdraw',
        signed_at: '2026-03-04T12:00:00.000Z',
        notes: 'Filed in the office cabinet',
      }),
    );

    expect(mockWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        athleteId: 'ath-1',
        parentId: 'p1',
        recordedByAccountId: 'acct-front-desk',
        signedAt: '2026-03-04T12:00:00.000Z',
        notes: 'Filed in the office cabinet',
      }),
      TX,
    );
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
    mockSweep.mockResolvedValueOnce(['pub-1', 'pub-2']);

    const response = await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(response.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith(
      expect.objectContaining({ athleteId: 'ath-1', reason: 'guardian_consent_withdrawn' }),
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ retracted_publication_ids: ['pub-1', 'pub-2'] }),
    );
  });

  test('a withdrawal writes its own consent_withdrawn event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'consent_withdrawn',
        entity_type: 'guardian_media_consent',
        entity_id: 'ath-1',
        actor_role: 'coach',
      }),
    );
  });

  test('every retracted publication is independently auditable, not just the withdrawal', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSweep.mockResolvedValueOnce(['pub-1', 'pub-2']);

    await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    for (const publicationId of ['pub-1', 'pub-2']) {
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'video_publication',
          entity_id: publicationId,
          details: expect.objectContaining({ action: 'publication_retracted_on_consent_withdrawal' }),
        }),
      );
    }
  });

  test('a failed sweep is itself recorded, so the gap is reconstructable', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSweep.mockRejectedValueOnce(new Error('suppression failed'));

    await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ action: 'consent_withdrawal_suppression_failed' }),
      }),
    );
  });

  test('a failed sweep surfaces as a 500 and records nothing -- the withdrawal rolls back with it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSweep.mockRejectedValueOnce(new Error('suppression failed'));

    const response = await POST(jsonRequest({ ...GRANT_BODY, decision: 'withdraw' }));

    expect(response.status).toBe(500);
    expect(mockWithdraw).toHaveBeenCalledTimes(1);
    expect(mockWithdraw).toHaveBeenCalledWith(expect.anything(), TX);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual(expect.objectContaining({ ok: false }));
    // Nothing was recorded, so no waiver id is offered and no withdrawal event claims one.
    expect(body).not.toHaveProperty('waiver_id');
    expect(mockAudit).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: 'consent_withdrawn' }));
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ action: 'consent_withdrawal_suppression_failed', rolled_back: true }),
      }),
    );
  });
});

/*
 * Owner ruling (Jason, 2026-10-05, "A: Retract (Recommended)"): a consent
 * that leaves a guardian photo-only retracts published video, and staff
 * recording it does exactly what the guardian's own console does.
 */
describe('POST /api/pilot/admin/athlete-consent -- photo-only grant', () => {
  test('a staff-recorded photo-only consent retracts published media, exactly as the guardian console does', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSweep.mockResolvedValueOnce(['pub-9']);

    const response = await POST(jsonRequest({ ...GRANT_BODY, covers_video: false }));

    expect(response.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith({
      organizationId: 'org-a',
      athleteId: 'ath-1',
      suppressedByAccountId: 'acct-admin',
      reason: 'guardian_consent_photo_only',
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true, waiver_id: 'wv-1', retracted_publication_ids: ['pub-9'] }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'video_publication',
        entity_id: 'pub-9',
        details: expect.objectContaining({ action: 'publication_retracted_on_consent_photo_only', parent_id: 'p1' }),
      }),
    );
  });

  test('a failed photo-only sweep is a 500 and is audited -- and the consent rolls back with it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSweep.mockRejectedValueOnce(new Error('suppression failed'));

    const response = await POST(jsonRequest({ ...GRANT_BODY, covers_video: false }));

    expect(response.status).toBe(500);
    expect(mockGrant).toHaveBeenCalledTimes(1);
    expect(mockGrant).toHaveBeenCalledWith(expect.anything(), TX);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual(expect.objectContaining({ ok: false }));
    expect(body).not.toHaveProperty('waiver_id');
    expect(mockAudit).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: 'consent_granted' }));
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ action: 'consent_photo_only_suppression_failed' }),
      }),
    );
  });
});
