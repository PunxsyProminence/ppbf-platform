import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { getAthleteById } from '@/src/server/pilot/entities';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { ConflictError } from '@/src/server/pilot/errors';
import { assertGuardianMediaConsent, GuardianConsentMissingError } from '@/src/server/pilot/guardianConsent';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  decidePublicationCompliance,
  getLatestPublicationCheck,
  getOrganizationPublications,
  getPublicationForPublish,
  reopenRetractedPublication,
  retractPublication,
} from '@/src/server/pilot/publication';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';
import { assertConsentCoversVideo, mintUnderPlaybackConsent } from '@/src/server/pilot/videoPlaybackConsent';

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
  retractPublication: jest.fn(),
  reopenRetractedPublication: jest.fn(),
}));

jest.mock('@/src/server/pilot/profileDb', () => ({
  getSubjectIdentity: jest.fn(),
}));

// No clip tags unless a test says so (videoClipTags.ts).
jest.mock('@/src/server/pilot/videoClipTags', () => ({
  listLiveTagSubjects: jest.fn(async () => []),
}));
// The playback gate is the shared helper; its transaction, lock order and
// refusals are proven in its own suites (playbackConsentRace.pg.test.ts).
// Here it passes straight through to the mint unless a test says otherwise.
jest.mock('@/src/server/pilot/videoPlaybackConsent', () => ({
  mintUnderPlaybackConsent: jest.fn(async (_org: string, _ids: string[], mint: () => unknown) => mint()),
  assertConsentCoversVideo: jest.fn(async () => undefined),
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
const mockTagSubjects = jest.mocked(listLiveTagSubjects);
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
const mockRetract = jest.mocked(retractPublication);
const mockMintUnderConsent = jest.mocked(mintUnderPlaybackConsent);
const mockCoversVideo = jest.mocked(assertConsentCoversVideo);
const mockReopen = jest.mocked(reopenRetractedPublication);

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
  // GET lists twice per request (pending_review queue, then drafts); tests
  // that only care about one of the two lean on this empty default for the
  // other.
  mockList.mockResolvedValue([]);
});

describe('GET /api/pilot/admin/video-compliance', () => {
  test('an organization admin lists the pending-review queue with resolved names and a stream url', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockImplementation(async (_org, filters) =>
      (filters as { status?: string } | undefined)?.status === 'pending_review' ? [publication()] as never : [] as never);
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
          tagged_clip: false,
          playback_blocked: null,
        },
      ],
      drafts: [],
      published: [],
      retracted: [],
    });
  });

  test('the queue response carrying SAS stream urls is not storable by any cache', async () => {
    // Each stream_url is a bearer credential to a minor's footage, and this
    // queue hands out a batch of them in one response -- so a copy retained by
    // the browser or by an intermediary is a batch disclosure that outlives the
    // org-admin check above.
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockImplementation(async (_org, filters) =>
      (filters as { status?: string } | undefined)?.status === 'pending_review' ? [publication()] as never : [] as never);
    mockGetAthlete.mockResolvedValueOnce({ athlete_id: 'ath-1', full_name: 'Sample Athlete' } as never);
    mockGetSubjectIdentity.mockResolvedValueOnce({ accountId: 'acct-coach', fullName: 'Coach Alice', athleteId: null } as never);
    mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-1', blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: Array<{ stream_url: string | null }> };
    expect(payload.items[0].stream_url).toBe('https://blob.example/sas');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('published and retracted rows are listed for the lifecycle levers, without SAS urls', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockImplementation(async (_org, filters) => {
      const status = (filters as { status?: string } | undefined)?.status;
      if (status === 'published') return [publication({ status: 'published', publication_id: 'pub-live' })] as never;
      if (status === 'retracted') return [publication({ status: 'retracted', publication_id: 'pub-gone' })] as never;
      return [] as never;
    });
    mockGetAthlete.mockResolvedValue({ athlete_id: 'ath-1', full_name: 'Sample Athlete' } as never);
    mockGetSubjectIdentity.mockResolvedValue({ accountId: 'acct-coach', fullName: 'Coach Alice', athleteId: null } as never);

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      published: Array<{ publication_id: string }>;
      retracted: Array<{ publication_id: string }>;
    };
    expect(payload.published.map((r) => r.publication_id)).toEqual(['pub-live']);
    expect(payload.retracted.map((r) => r.publication_id)).toEqual(['pub-gone']);
    expect(mockSasUrl).not.toHaveBeenCalled();
  });

  test('drafts are listed alongside the queue, with the creating coach resolved', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockImplementation(async (_org, filters) =>
      (filters as { status?: string } | undefined)?.status === 'draft'
        ? [publication({ status: 'draft', compliance_check_status: 'pending' })] as never
        : [] as never);
    mockGetAthlete.mockResolvedValueOnce({ athlete_id: 'ath-1', full_name: 'Sample Athlete' } as never);
    mockGetSubjectIdentity.mockResolvedValueOnce({ accountId: 'acct-coach', fullName: 'Coach Alice', athleteId: null } as never);

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a', { status: 'draft' });
    const payload = (await response.json()) as {
      items: unknown[];
      drafts: Array<{ publication_id: string; uploader_name: string | null; athlete_name: string | null }>;
    };
    expect(payload.items).toEqual([]);
    expect(payload.drafts).toEqual([
      {
        publication_id: 'pub-1',
        title: 'Sparring Round 1',
        description: 'Session footage.',
        athlete_id: 'ath-1',
        athlete_name: 'Sample Athlete',
        uploader_account_id: 'acct-coach',
        uploader_name: 'Coach Alice',
        created_at: '2026-08-01T00:00:00Z',
      },
    ]);
    // Routing a draft into review needs no footage on screen -- no SAS url
    // is minted for drafts.
    expect(mockSasUrl).not.toHaveBeenCalled();
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

  test('a tagged sparring or bout clip gets no stream_url on the console', async () => {
    // Its other athletes' consent is not what this queue checks, and tagged
    // clips are staff film study only (owner, 2026-10-03).
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockImplementation(async (_org, filters) =>
      (filters as { status?: string } | undefined)?.status === 'pending_review' ? [publication()] as never : [] as never);
    mockGetAthlete.mockResolvedValueOnce(null);
    mockGetSubjectIdentity.mockResolvedValueOnce(null);
    mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-1', blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);
    mockTagSubjects.mockResolvedValueOnce([{ athlete_id: 'ath-2', athlete_deleted: false }]);

    const response = await GET(request('/api/pilot/admin/video-compliance'));

    const payload = (await response.json()) as { items: Array<{ stream_url: string | null; tagged_clip: boolean }> };
    expect(payload.items[0]).toMatchObject({ stream_url: null, tagged_clip: true });
    expect(mockSasUrl).not.toHaveBeenCalled();
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

  // Owner ruling 2026-10-05 (option B, "Apply consent check"): the queue's
  // playback link goes through the same consent gate as every other playback
  // surface. A withdrawn or photo-only guardian means no link, and the item
  // says why; the admin can still reject it or send it back.
  describe('playback consent (owner ruling 2026-10-05, option B)', () => {
    function queueOneItem(status = 'ready') {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockList.mockImplementation(async (_org, filters) =>
        (filters as { status?: string } | undefined)?.status === 'pending_review' ? [publication()] as never : [] as never);
      mockGetAthlete.mockResolvedValueOnce(null);
      mockGetSubjectIdentity.mockResolvedValueOnce(null);
      mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-1', blob_path: '/blob/vs-1.mp4', status } as never);
    }

    async function onlyItem() {
      const response = await GET(request('/api/pilot/admin/video-compliance'));
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { items: Array<{ stream_url: string | null; playback_blocked: string | null }> };
      expect(payload.items).toHaveLength(1);
      return payload.items[0];
    }

    test('the link is minted under the playback consent gate for the publication athlete', async () => {
      queueOneItem();

      const item = await onlyItem();

      expect(mockMintUnderConsent).toHaveBeenCalledWith('org-a', ['ath-1'], expect.any(Function));
      expect(item).toMatchObject({ stream_url: 'https://blob.example/sas', playback_blocked: null });
    });

    test('a withdrawn guardian consent mints no link and says consent_withdrawn', async () => {
      queueOneItem();
      mockMintUnderConsent.mockRejectedValueOnce(new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'));

      const item = await onlyItem();

      expect(item).toMatchObject({ stream_url: null, playback_blocked: 'consent_withdrawn' });
      expect(mockSasUrl).not.toHaveBeenCalled();
    });

    test('a photo-only guardian consent mints no link and says photo_only', async () => {
      queueOneItem();
      mockMintUnderConsent.mockRejectedValueOnce(new ConflictError('Blocked: photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));

      const item = await onlyItem();

      expect(item).toMatchObject({ stream_url: null, playback_blocked: 'photo_only' });
      expect(mockSasUrl).not.toHaveBeenCalled();
    });

    test('an unreadable consent record fails closed: no link, and the queue still loads', async () => {
      queueOneItem();
      mockMintUnderConsent.mockRejectedValueOnce(new ConflictError('Blocked: unreadable', 'GUARDIAN_CONSENT_UNREADABLE'));

      const item = await onlyItem();

      expect(item).toMatchObject({ stream_url: null, playback_blocked: 'consent_unverified' });
      expect(mockSasUrl).not.toHaveBeenCalled();
    });

    test('a consent read fault fails closed: no link, the queue still loads, and the fault is logged without its message', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      queueOneItem();
      mockMintUnderConsent.mockRejectedValueOnce(Object.assign(new Error('connection to db-host:5432 refused'), { code: '08006' }));

      const item = await onlyItem();

      expect(item).toMatchObject({ stream_url: null, playback_blocked: 'consent_unverified' });
      expect(mockSasUrl).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith({ event: 'video-compliance-playback-mint-failed', code: '08006' });
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('db-host');
      consoleErrorSpy.mockRestore();
    });

    test('an item with no playable footage is not sent through the gate at all', async () => {
      queueOneItem('quarantined');

      const item = await onlyItem();

      expect(item).toMatchObject({ stream_url: null, playback_blocked: null });
      expect(mockMintUnderConsent).not.toHaveBeenCalled();
    });

    test('reject and request_changes never run the video-coverage check, so a blocked item can still be decided', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockCoversVideo.mockRejectedValue(new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'));

      try {
        const rejected = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject', note: 'Consent withdrawn.' }));
        const sentBack = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes', note: 'Hold for consent.' }));

        expect(rejected.status).toBe(200);
        expect(sentBack.status).toBe(200);
        expect(mockDecide).toHaveBeenCalledTimes(2);
        expect(mockCoversVideo).not.toHaveBeenCalled();
      } finally {
        mockCoversVideo.mockReset();
        mockCoversVideo.mockResolvedValue(undefined);
      }
    });
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
  beforeEach(() => {
    // The publication's video is attributed to its athlete unless a test
    // says otherwise.
    mockGetVideoSession.mockResolvedValue({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-1', blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);
  });

  // Audit CL-B4: approval checks consent for the one athlete the publication
  // names. Footage attributed to nobody -- team footage -- shows children
  // that check never reads, so it cannot be approved for publication.
  describe('unattributed footage (audit CL-B4)', () => {
    test('approve is refused with 409 when the video is not linked to an athlete, and the row is never touched', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: null, blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: string; code?: string };
      expect(body.code).toBe('VIDEO_NOT_ATTRIBUTED');
      expect(body.error).toMatch(/isn't linked to an athlete/);
      expect(mockGetVideoSession).toHaveBeenCalledWith('org-a', 'vs-1');
      expect(mockDecide).not.toHaveBeenCalled();
    });

    test('approve is refused when the video cannot be found, since its attribution cannot be confirmed', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetVideoSession.mockResolvedValueOnce(null);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(409);
      expect(((await response.json()) as { code?: string }).code).toBe('VIDEO_NOT_ATTRIBUTED');
      expect(mockDecide).not.toHaveBeenCalled();
    });

    // A publication drafted before create compared the two (f8729bf4,
    // 2026-07-31) can name one child on another child's video. Approval's
    // consent checks read the named child, so the child on film is skipped.
    test('approve is refused with 409 when the video belongs to a different athlete, before any consent check', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetVideoSession.mockResolvedValueOnce({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-2', blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(409);
      expect(((await response.json()) as { code?: string }).code).toBe('VIDEO_ATHLETE_MISMATCH');
      expect(mockAssertConsent).not.toHaveBeenCalled();
      expect(mockCoversVideo).not.toHaveBeenCalled();
      expect(mockDecide).not.toHaveBeenCalled();
    });

    test.each([
      ['reject', 'rejected'],
      ['request_changes', 'pending_review'],
    ])('%s still works on a mismatched item, so the queue can be cleared', async (decision, newStatus) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetVideoSession.mockResolvedValue({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: 'ath-2', blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision, note: 'Wrong athlete named.' }));

      expect(response.status).toBe(200);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ newStatus }));
    });

    test('reject still works on an unattributed item, so the queue can be cleared', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetVideoSession.mockResolvedValue({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: null, blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject', note: 'Team footage.' }));

      expect(response.status).toBe(200);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ newStatus: 'rejected' }));
    });

    test('request_changes still works on an unattributed item', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetVideoSession.mockResolvedValue({ video_session_id: 'vs-1', organization_id: 'org-a', athlete_id: null, blob_path: '/blob/vs-1.mp4', status: 'ready' } as never);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes', note: 'Link the athlete.' }));

      expect(response.status).toBe(200);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ newStatus: 'pending_review' }));
    });
  });

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
      // T-008 round-8: an approve decision re-verifies guardian consent
      // INSIDE decidePublicationCompliance's own transaction, closing the
      // race between the fast pre-check above and the CAS UPDATE.
      verifyBeforeCommit: expect.any(Function),
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
    });

    // Round-8 review finding: a blocked approval attempt is itself a
    // safeguarding-relevant fact -- "who tried to approve unconsented
    // footage of this child, and when" -- and a prior version of this route
    // (and this very test) let it pass completely unaudited.
    test('a blocked approval attempt is itself audited, with the missing parent ids', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockAssertConsent.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', ['parent-1']));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(409);
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'update',
          actor_account_id: 'acct-admin',
          entity_type: 'video_publication',
          entity_id: 'pub-1',
          details: expect.objectContaining({
            action: 'publication_compliance_approve_blocked_by_consent',
            missing_parent_ids: ['parent-1'],
          }),
        }),
      );
    });

    test('approve proceeds once consent is verified', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(200);
      expect(mockAssertConsent).toHaveBeenCalledWith('org-a', 'ath-1');
      expect(mockDecide).toHaveBeenCalled();
    });

    // Overwatch 2026-10-05, same lane: approve checked that every guardian had
    // SIGNED, never that what they signed covers video, so a photo-only
    // guardian's child's video could be approved for publication.
    test('approve is refused with 409 when a guardian signed photo-only consent, audited, and the row is never touched', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockCoversVideo.mockRejectedValueOnce(new ConflictError('Blocked: photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'GUARDIAN_CONSENT_EXCLUDES_VIDEO' });
      expect(mockCoversVideo).toHaveBeenCalledWith('org-a', 'ath-1');
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: 'pub-1',
          details: expect.objectContaining({
            action: 'publication_compliance_approve_blocked_by_consent',
            reason: 'GUARDIAN_CONSENT_EXCLUDES_VIDEO',
          }),
        }),
      );
    });

    test('the in-transaction re-check before the approve commits also requires video coverage, on the same client', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      let verify: ((client: never) => Promise<void>) | undefined;
      mockDecide.mockImplementationOnce(async (params) => {
        verify = (params as { verifyBeforeCommit?: (client: never) => Promise<void> }).verifyBeforeCommit;
        return true;
      });

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'approve' }));
      expect(response.status).toBe(200);
      expect(verify).toBeDefined();

      // A client whose consent read passes the signed-consent check, so the
      // coverage check is what refuses.
      const client = {
        query: jest.fn(async (text: string) => ({
          rows: /retained_media_consent_restrictions/.test(text)
            ? [] // no purged guardian's choice retained
            : /guardian_links/.test(text)
              ? [{ parent_id: 'parent-1' }]
              : [{ parent_id: 'parent-1', status: 'signed', covers_video: false, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }],
        })),
      } as never;
      mockCoversVideo.mockClear();
      mockCoversVideo.mockRejectedValueOnce(new ConflictError('Blocked: photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));
      await expect(verify!(client)).rejects.toMatchObject({ code: 'GUARDIAN_CONSENT_EXCLUDES_VIDEO' });
      expect(mockCoversVideo).toHaveBeenCalledWith('org-a', 'ath-1', client);
    });

    test('reject and request_changes are never gated on consent -- neither publishes anything', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

      await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reject', note: 'Off-topic subject.' }));
      await POST(jsonRequest({ publication_id: 'pub-1', decision: 'request_changes', note: 'Trim the clip.' }));

      expect(mockAssertConsent).not.toHaveBeenCalled();
      expect(mockCoversVideo).not.toHaveBeenCalled();
    });
  });

  describe('retraction lifecycle levers', () => {
    test('a retraction without a stated reason is refused before anything is read', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'retract' }));

      expect(response.status).toBe(400);
      expect(mockGetForPublish).not.toHaveBeenCalled();
      expect(mockRetract).not.toHaveBeenCalled();
    });

    test('retract suppresses a published publication with the reason and audits it', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'published' }));
      mockRetract.mockResolvedValueOnce(true);

      const response = await POST(
        jsonRequest({ publication_id: 'pub-1', decision: 'retract', note: 'Guardian asked us to pull it.' }),
      );

      expect(response.status).toBe(200);
      expect(mockRetract).toHaveBeenCalledWith({
        organizationId: 'org-a',
        publicationId: 'pub-1',
        suppressedByAccountId: 'acct-admin',
        reason: 'Guardian asked us to pull it.',
      });
      const body = (await response.json()) as { status?: string };
      expect(body.status).toBe('retracted');
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: 'pub-1',
          details: expect.objectContaining({ action: 'publication_retracted' }),
        }),
      );
      // Retracting is not a compliance decision: no check row, no consent
      // gate -- and nothing here can grant or restore a guardian's consent.
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockAssertConsent).not.toHaveBeenCalled();
    });

    test('only a published publication can be retracted', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'pending_review' }));
      mockRetract.mockResolvedValueOnce(false);

      const response = await POST(
        jsonRequest({ publication_id: 'pub-1', decision: 'retract', note: 'reason' }),
      );

      expect(response.status).toBe(409);
    });

    test('reopen sends a retracted publication back into review, never to published', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'retracted' }));
      mockReopen.mockResolvedValueOnce(true);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));

      expect(response.status).toBe(200);
      const body = (await response.json()) as { status?: string };
      expect(body.status).toBe('pending_review');
      expect(mockReopen).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-a', publicationId: 'pub-1', verifyBeforeCommit: expect.any(Function) }),
      );
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ action: 'publication_reopened_for_review' }),
        }),
      );
      // Reopening runs the same consent gate as publishing: signed AND
      // covering video.
      expect(mockCoversVideo).toHaveBeenCalledWith('org-a', 'ath-1');
      expect(mockAssertConsent).toHaveBeenCalledWith('org-a', 'ath-1');
    });

    // A consent retraction (owner decision 2026-08-14; OD-2026-10-05-021,
    // "A: Retract (Recommended)") must not be undone while that consent still
    // stands. Approve and publish would refuse later anyway; refusing here
    // keeps the item out of the queue and tells the admin why now.
    test.each([
      ['GUARDIAN_CONSENT_WITHDRAWN', 'Blocked: withdrawn'],
      ['GUARDIAN_CONSENT_EXCLUDES_VIDEO', 'Blocked: photo-only'],
      ['GUARDIAN_CONSENT_UNREADABLE', 'Blocked: unreadable'],
    ])('reopen is refused with 409 under %s, audited, and the row is never touched', async (code, message) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'retracted' }));
      mockCoversVideo.mockRejectedValueOnce(new ConflictError(message, code));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code });
      expect(mockReopen).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: 'pub-1',
          details: expect.objectContaining({ action: 'publication_reopen_blocked_by_consent', reason: code }),
        }),
      );
      expect(mockAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ action: 'publication_reopened_for_review' }) }),
      );
    });

    // Coverage runs first so a withdrawn guardian is refused as withdrawn,
    // not as missing paperwork -- different facts the admin acts on
    // differently (videoPlaybackConsent.ts).
    test('a withdrawn guardian is refused as withdrawn, not as missing consent', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'retracted' }));
      mockCoversVideo.mockRejectedValueOnce(new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'));
      // Armed so that a signed-first order would surface as missing consent.
      // Coverage refuses first, so this rejection is never consumed; reset it
      // so it cannot leak into a later test (clearAllMocks keeps Once queues).
      mockAssertConsent.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', ['parent-1']));

      try {
        const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: 'GUARDIAN_CONSENT_WITHDRAWN' });
        expect(mockAssertConsent).not.toHaveBeenCalled();
        expect(mockReopen).not.toHaveBeenCalled();
      } finally {
        mockAssertConsent.mockReset();
      }
    });

    test('reopen is refused with 409 when guardian consent is missing, audited with the missing parent ids', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'retracted' }));
      mockAssertConsent.mockRejectedValueOnce(new GuardianConsentMissingError('ath-1', ['parent-1']));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/consent/i) });
      expect(mockReopen).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: 'pub-1',
          details: expect.objectContaining({
            action: 'publication_reopen_blocked_by_consent',
            missing_parent_ids: ['parent-1'],
          }),
        }),
      );
    });

    test('the in-transaction re-check before the reopen commits locks consent and requires video coverage, on the same client', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'retracted' }));
      let verify: ((client: never) => Promise<void>) | undefined;
      mockReopen.mockImplementationOnce(async (params) => {
        verify = (params as { verifyBeforeCommit?: (client: never) => Promise<void> }).verifyBeforeCommit;
        return true;
      });

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));
      expect(response.status).toBe(200);
      expect(verify).toBeDefined();

      // Signed consent passes the signed check (the real, unmocked
      // assertGuardianMediaConsentWithClient, which takes the guardian_links
      // FOR SHARE lock), so the coverage check is what refuses.
      const client = {
        query: jest.fn(async (text: string) => ({
          rows: /retained_media_consent_restrictions/.test(text)
            ? [] // no purged guardian's choice retained
            : /guardian_links/.test(text)
              ? [{ parent_id: 'parent-1' }]
              : [{ parent_id: 'parent-1', status: 'signed', covers_video: false, public_use_allowed: false, created_at: '2026-08-01T00:00:00Z' }],
        })),
      } as never;
      mockCoversVideo.mockClear();
      mockCoversVideo.mockRejectedValueOnce(new ConflictError('Blocked: photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));
      await expect(verify!(client)).rejects.toMatchObject({ code: 'GUARDIAN_CONSENT_EXCLUDES_VIDEO' });
      const lockSql = (client as unknown as { query: jest.Mock }).query.mock.calls.map(([text]) => text as string);
      expect(lockSql.some((text) => /guardian_links/.test(text) && /for share/i.test(text))).toBe(true);
      expect(mockCoversVideo).toHaveBeenCalledWith('org-a', 'ath-1', client);
    });

    test('a withdrawal in the reopen transaction refuses it and is audited', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'retracted' }));
      mockReopen.mockRejectedValueOnce(new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'));

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'GUARDIAN_CONSENT_WITHDRAWN' });
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            action: 'publication_reopen_blocked_by_consent',
            reason: 'GUARDIAN_CONSENT_WITHDRAWN',
          }),
        }),
      );
    });

    test('only a retracted publication can be reopened', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(publication({ status: 'published' }));
      mockReopen.mockResolvedValueOnce(false);

      const response = await POST(jsonRequest({ publication_id: 'pub-1', decision: 'reopen_review' }));

      expect(response.status).toBe(409);
    });

    test('a cross-org publication is indistinguishable from a missing one', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
      mockGetForPublish.mockResolvedValueOnce(null as never);

      const response = await POST(
        jsonRequest({ publication_id: 'pub-other-org', decision: 'retract', note: 'reason' }),
      );

      expect(response.status).toBe(404);
      expect(mockRetract).not.toHaveBeenCalled();
    });
  });
});
