import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { getAthleteById } from '@/src/server/pilot/entities';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getOrganizationPublications,
  getPublicationForPublish,
  recordComplianceCheck,
  updatePublicationStatus,
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

jest.mock('@/src/server/pilot/publication', () => ({
  getOrganizationPublications: jest.fn(),
  getPublicationForPublish: jest.fn(),
  recordComplianceCheck: jest.fn(),
  updatePublicationStatus: jest.fn(),
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
const mockRecordCheck = jest.mocked(recordComplianceCheck);
const mockUpdateStatus = jest.mocked(updatePublicationStatus);
const mockGetAthlete = jest.mocked(getAthleteById);
const mockGetSubjectIdentity = jest.mocked(getSubjectIdentity);
const mockGetVideoSession = jest.mocked(getVideoSessionById);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockSasUrl = jest.mocked(getPilotVideoSasUrl);

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
  mockUpdateStatus.mockResolvedValue(true);
  mockRecordCheck.mockResolvedValue({ check_id: 'check-1', publication_id: 'pub-1', check_type: 'compliance', check_status: 'passed', details: '' } as never);
  mockGetForPublish.mockResolvedValue(publication());
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
          stream_url: 'https://blob.example/sas',
        },
      ],
    });
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
  test('approve moves the publication to approved with compliance_check_status=passed, no note required', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith('org-a', 'pub-1', 'approved', 'passed', 'acct-admin', 'pending_review');
    expect(mockRecordCheck).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', publicationId: 'pub-1', checkType: 'compliance', checkStatus: 'passed', details: '' }),
    );
    await expect(response.json()).resolves.toEqual({ ok: true, publication_id: 'pub-1', status: 'approved', compliance_check_status: 'passed' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'video_publication',
        entity_id: 'pub-1',
        details: expect.objectContaining({ action: 'publication_compliance_approve' }),
      }),
    );
  });

  test('reject moves the publication to the real terminal rejected status, not draft, and requires a note', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject', note: 'Off-topic subject visible in frame.' }));

    expect(response.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith('org-a', 'pub-1', 'rejected', 'failed', undefined, 'pending_review');
    expect(mockRecordCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkStatus: 'failed', details: 'Off-topic subject visible in frame.' }),
    );
    await expect(response.json()).resolves.toMatchObject({ status: 'rejected' });
  });

  test('reject without a note is a 400, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject' }));

    expect(response.status).toBe(400);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('request_changes keeps the publication in pending_review and requires a note', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes', note: 'Please trim the last 10 seconds.' }));

    expect(response.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith('org-a', 'pub-1', 'pending_review', 'manual_review', undefined, 'pending_review');
    await expect(response.json()).resolves.toMatchObject({ status: 'pending_review', compliance_check_status: 'manual_review' });
  });

  test('request_changes without a note is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes' }));

    expect(response.status).toBe(400);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
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

  test('an unrecognized decision is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'delete' }));

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

  test('a publication_id that does not belong to this organization is a hidden 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetForPublish.mockResolvedValueOnce(null);

    const response = await POST(jsonRequest({ publication_id: 'pub-other-org', decision: 'approve' }));

    expect(response.status).toBe(404);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  // Two admins racing the same publication: the CAS-guarded updatePublicationStatus
  // resolves false when it loses (the row's status no longer matches
  // 'pending_review' by the time this request's UPDATE acquires the lock).
  test('losing the CAS race is refused, and nothing else is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockUpdateStatus.mockResolvedValueOnce(false);

    const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockUpdateStatus).toHaveBeenCalledWith('org-a', 'pub-1', 'approved', 'passed', 'acct-admin', 'pending_review');
    expect(mockRecordCheck).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
