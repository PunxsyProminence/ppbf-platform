import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { getAthleteById } from '@/src/server/pilot/entities';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { assertGuardianMediaConsent, GuardianConsentMissingError } from '@/src/server/pilot/guardianConsent';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  decidePublicationCompliance,
  getLatestPublicationCheck,
  getOrganizationPublications,
  getPublicationForPublish,
} from '@/src/server/pilot/publication';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

jest.mock('@/src/server/pilot/entities', () => ({
  getAthleteById: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/blob', () => ({
  getPilotVideoSasUrl: jest.fn(() => 'https://blob.example/sas'),
}));

// The real GuardianConsentMissingError class is preserved (not replaced)
// because http.ts's own jsonError does `error instanceof GuardianConsentMissingError`
// against THIS module -- mocking only assertGuardianMediaConsent keeps that
// instanceof check meaningful.
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    assertGuardianMediaConsent: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/publication', () => ({
  getOrganizationPublications: jest.fn(),
  getPublicationForPublish: jest.fn(),
  decidePublicationCompliance: jest.fn(),
  getLatestPublicationCheck: jest.fn(),
}));

jest.mock('@/src/server/pilot/profileDb', () => ({
  getSubjectIdentity: jest.fn(),
}));

jest.mock('@/src/server/pilot/videoSessions', () => ({
  getVideoSessionById: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
  };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(getOrganizationPublications);
const mockGetForPublish = jest.mocked(getPublicationForPublish);
const mockDecide = jest.mocked(decidePublicationCompliance);
const mockGetLatestCheck = jest.mocked(getLatestPublicationCheck);
const mockGetAthlete = jest.mocked(getAthleteById);
const mockGetSubjectIdentity = jest.mocked(getSubjectIdentity);
const mockGetVideoSession = jest.mocked(getVideoSessionById);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockSasUrl = jest.mocked(getPilotVideoSasUrl);
const mockAssertConsent = jest.mocked(assertGuardianMediaConsent);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
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
  return new NextRequest('https://ppbf.example/api/pilot/admin/video-compliance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function publication(overrides: Record<string, unknown> = {}) {
  return {
    publication_id: 'pub-1',
    video_session_id: 'vs-1',
    athlete_id: 'ath-1',
    submitted_by_account_id: 'acct-coach',
    publication_type: 'research_library',
    title: 'Sparring Round 1',
    description: 'Session footage.',
    tags: [],
    compliance_check_status: 'pending',
    metadata_complete: true,
    visibility: 'organization',
    status: 'pending_review',
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDecide.mockResolvedValue(true);
  mockGetForPublish.mockResolvedValue(publication());
  mockAssertConsent.mockResolvedValue(undefined);
});

describe('GET /api/pilot/admin/video-compliance', () => {
  test('an organization admin lists the pending-review queue with resolved names and a stream url', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([publication()]);
    mockGetAthlete.mockResolvedValueOnce({ athlete_id: 'ath-1', full_name: 'Sample Athlete' } as never);
    mockGetSubjectIdentity.mockResolvedValueOnce({ accountId: 'acct-coach', fullName: 'Coach Alice', athleteId: null } as never);
    mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-1', blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a', { status: 'pending_review' });
    // compliance_check_status is 'pending' here, so no prior review has
    // happened and the latest-check lookup must not even run.
    expect(mockGetLatestCheck).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: true,
      items: [
        {
          publication_id: 'pub-1',
          title: 'Sparring Round 1',
          description: 'Session footage.',
          athlete_id: 'ath-1',
          athlete_name: 'Sample Athlete',
          uploader_account_id: 'acct-coach',
          uploader_name: 'Coach Alice',
          created_at: '2026-08-01T00:00:00Z',
          compliance_check_status: 'pending',
          previous_review_note: null,
          stream_url: 'https://blob.example/sas',
        },
      ],
    });
  });

  // T-006 round-6 review finding: a re-queued item (compliance_check_status
  // = 'manual_review', from a prior 'request_changes') must surface the
  // prior reviewer's note, or a second reviewer has no way to know one
  // review cycle already happened.
  test('a re-queued item (manual_review) surfaces the previous reviewer note', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([publication({ compliance_check_status: 'manual_review' })]);
    mockGetAthlete.mockResolvedValueOnce(null);
    mockGetSubjectIdentity.mockResolvedValueOnce(null);
    mockGetVideoSession.mockResolvedValueOnce(null);
    mockGetLatestCheck.mockResolvedValueOnce({ check_status: 'manual_review', details: 'Trim the last 10 seconds.', checked_at: '2026-08-01T01:00:00Z' });

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    expect(mockGetLatestCheck).toHaveBeenCalledWith('org-a', 'pub-1');
    const payload = (await response.json()) as { items: Array<{ previous_review_note: string | null }> };
    expect(payload.items[0].previous_review_note).toBe('Trim the last 10 seconds.');
  });

  test('a video session that is not ready yet has no stream_url', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockList.mockResolvedValueOnce([publication()]);
    mockGetAthlete.mockResolvedValueOnce(null);
    mockGetSubjectIdentity.mockResolvedValueOnce(null);
    mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-1', blob_path: '/blob/vs-1.mp4', status: 'quarantined' } as never);

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    const payload = (await response.json()) as { items: Array<{ stream_url: string | null }> };
    expect(payload.items[0].stream_url).toBeNull();
    expect(mockSasUrl).not.toHaveBeenCalled();
  });

  test('non-admin roles are refused -- this is an org-admin-only console', async () => {
    for (const role of ['athlete', 'parent', 'coach', 'board', 'platform_owner']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/admin/video-compliance'));
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/video-compliance', () => {
  test('approve decides atomically and writes a fully-formed audit event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockDecide).toHaveBeenCalledWith({
      organizationId: 'org-a',
      publicationId: 'pub-1',
      newStatus: 'approved',
      checkStatus: 'passed',
      checkType: 'compliance',
      details: '',
      decidedByAccountId: 'acct-admin',
      approvedByAccountId: 'acct-admin',
      expectedCurrentStatus: 'pending_review',
    });
    await expect(response.json()).resolves.toEqual({ ok: true, publication_id: 'pub-1', status: 'approved', compliance_check_status: 'passed' });
    expect(mockAudit).toHaveBeenCalledWith({
      event_type: 'update',
      actor_account_id: 'acct-admin',
      actor_role: 'organization_admin',
      organization_id: 'org-a',
      entity_type: 'video_publication',
      entity_id: 'pub-1',
      details: {
        action: 'publication_compliance_approve',
        note: undefined,
        prior_status: 'pending_review',
        new_status: 'approved',
      },
      shadow_mirror: false,
    });
  });

  test('reject decides atomically to the real terminal rejected status, not draft, and audits it fully', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject', note: 'Off-topic subject visible in frame.' }));

    expect(response.status).toBe(200);
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        newStatus: 'rejected',
        checkStatus: 'failed',
        checkType: 'compliance',
        details: 'Off-topic subject visible in frame.',
        approvedByAccountId: undefined,
        expectedCurrentStatus: 'pending_review',
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ status: 'rejected' });
    // Round-6 finding: the sibling check/route.ts writes no audit event at
    // all -- this route's whole reason for the sibling gap being closeable
    // is that EVERY decision, not just approve, is logged.
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          action: 'publication_compliance_reject',
          note: 'Off-topic subject visible in frame.',
          prior_status: 'pending_review',
          new_status: 'rejected',
        }),
      }),
    );
  });

  test('reject without a note is a 400, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject' }));

    expect(response.status).toBe(400);
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('request_changes keeps the publication in pending_review, records the reason, and audits it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes', note: 'Please trim the last 10 seconds.' }));

    expect(response.status).toBe(200);
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        newStatus: 'pending_review',
        checkStatus: 'manual_review',
        details: 'Please trim the last 10 seconds.',
        approvedByAccountId: undefined,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ status: 'pending_review', compliance_check_status: 'manual_review' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ action: 'publication_compliance_request_changes', note: 'Please trim the last 10 seconds.' }),
      }),
    );
  });

  test('request_changes without a note is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes' }));

    expect(response.status).toBe(400);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  test('a coach cannot use the admin console route', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

    expect(response.status).toBe(403);
    expect(mockGetForPublish).not.toHaveBeenCalled();
  });

  test('missing publication_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockGetForPublish).not.toHaveBeenCalled();
  });

  test('a non-string publication_id (e.g. a number) is treated as missing, never coerced through', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 42, decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockGetForPublish).not.toHaveBeenCalled();
  });

  test('a malformed JSON body is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    const malformed = new NextRequest('https://ppbf.example/api/pilot/admin/video-compliance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });

    const response = await POST(malformed);

    expect(response.status).toBe(400);
    expect(mockGetForPublish).not.toHaveBeenCalled();
  });

  test('an unrecognized decision is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'delete' }));

    expect(response.status).toBe(400);
    expect(mockGetForPublish).not.toHaveBeenCalled();
  });

  test('a publication_id that does not belong to this organization is a hidden 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetForPublish.mockResolvedValueOnce(null);

    const response = await POST(jsonRequest({ publication_id: 'pub-other-org', decision: 'approve' }));

    expect(response.status).toBe(404);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  // Two admins racing the same publication: the CAS-guarded transaction
  // resolves false when it loses (the row's status no longer matches
  // 'pending_review' by the time this request's UPDATE acquires the lock).
  // Because the status flip and the check-record insert are now one
  // transaction, a lost race writes NOTHING -- not a half-applied state.
  test('losing the CAS race is refused, and nothing is written at all', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockDecide.mockResolvedValueOnce(false);

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ expectedCurrentStatus: 'pending_review' }));
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // Round-6 finding fixed: a failed audit write must not undo or mask an
  // already-committed compliance decision -- same doctrine as
  // training-holds' auditHoldEvent. The decision is atomic (decidePublicationCompliance);
  // only the best-effort audit copy can fail independently.
  test('a failed audit write does not fail the request -- the decision already committed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAudit.mockRejectedValueOnce(Object.assign(new Error('insert failed'), { code: '23514' }));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'approved' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'video-compliance-audit-write-failed' }),
    );
    consoleErrorSpy.mockRestore();
  });

  // T-008: approving is gated on guardian media consent.
  describe('guardian media consent gate (T-008)', () => {
    test('approve is refused with 409 when guardian consent is missing, and the row is never touched', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockAssertConsent.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', ['parent-1']));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(409);
      expect(mockAssertConsent).toHaveBeenCalledWith('org-a', 'ath-1');
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });

    test('approve proceeds once consent is verified', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(200);
      expect(mockAssertConsent).toHaveBeenCalledWith('org-a', 'ath-1');
      expect(mockDecide).toHaveBeenCalled();
    });

    test('reject and request_changes are never gated on consent -- neither publishes anything', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

      await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject', note: 'Off-topic subject.' }));
      await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes', note: 'Trim the clip.' }));

      expect(mockAssertConsent).not.toHaveBeenCalled();
    });
  });
});
