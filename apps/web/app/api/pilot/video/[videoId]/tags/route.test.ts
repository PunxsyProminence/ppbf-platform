import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
import { accessibleAthleteIds, assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  addClipTag,
  getLiveClipTag,
  listLiveClipTagsForVideo,
  listLiveTagSubjects,
  removeClipTag,
} from '@/src/server/pilot/videoClipTags';
import { ConflictError } from '@/src/server/pilot/errors';
import { assertConsentCoversVideo } from '@/src/server/pilot/videoPlaybackConsent';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, accessibleAthleteIds: jest.fn(), assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/videoSessions', () => ({ getVideoSessionById: jest.fn() }));
jest.mock('@/src/server/pilot/videoPlaybackConsent', () => ({ assertConsentCoversVideo: jest.fn() }));
// Only the database calls are doubled; the module's own rules are proved by
// videoClipTags.pg.test.ts against a real schema.
jest.mock('@/src/server/pilot/videoClipTags', () => ({
  addClipTag: jest.fn(),
  getLiveClipTag: jest.fn(),
  listLiveClipTagsForVideo: jest.fn(),
  listLiveTagSubjects: jest.fn(),
  removeClipTag: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAccessible = jest.mocked(accessibleAthleteIds);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockVideo = jest.mocked(getVideoSessionById);
const mockAdd = jest.mocked(addClipTag);
const mockGetTag = jest.mocked(getLiveClipTag);
const mockListForVideo = jest.mocked(listLiveClipTagsForVideo);
const mockSubjects = jest.mocked(listLiveTagSubjects);
const mockRemove = jest.mocked(removeClipTag);
const mockConsent = jest.mocked(assertConsentCoversVideo);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const video = (athleteId: string | null = 'ath-1') => ({
  video_session_id: 'vid-1',
  organization_id: 'org-1',
  athlete_id: athleteId,
  blob_path: 'p',
  status: 'ready',
});

const tagRow = (overrides: Record<string, unknown> = {}) => ({
  tag_id: 'vct-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  event_kind: 'sparring' as const,
  competition_id: null,
  note: '',
  tagged_by_account_id: 'coach-1',
  created_at: '2026-10-03T00:00:00.000Z',
  ...overrides,
});

const params = { params: Promise.resolve({ videoId: 'vid-1' }) };

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/pilot/video/vid-1/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params,
  );
}

function del(tagId = 'vct-1') {
  return DELETE(
    new NextRequest(`http://localhost/api/pilot/video/vid-1/tags?tag_id=${tagId}`, { method: 'DELETE' }),
    params,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  mockPrincipal.mockResolvedValue(principal());
  mockVideo.mockResolvedValue(video());
  mockSubjects.mockResolvedValue([]);
  mockAccessible.mockResolvedValue(new Set(['ath-1']));
  mockAssertAccess.mockResolvedValue(undefined);
  mockAdd.mockResolvedValue(tagRow());
  mockConsent.mockResolvedValue(undefined);
});

describe('who may tag', () => {
  test.each(['athlete', 'parent', 'volunteer', 'platform_owner'] as const)('%s is refused', async (role) => {
    mockPrincipal.mockResolvedValueOnce(principal({ role }));
    const res = await post({ athlete_id: 'ath-1', event_kind: 'sparring' });
    expect(res.status).toBe(403);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('a coach tags their athlete on a video they can see, and it is audited', async () => {
    const res = await post({ athlete_id: 'ath-1', event_kind: 'competition', competition_id: 'comp-1', note: ' first bout ' });

    expect(res.status).toBe(201);
    expect(mockAdd).toHaveBeenCalledWith({
      organizationId: 'org-1',
      videoSessionId: 'vid-1',
      athleteId: 'ath-1',
      eventKind: 'competition',
      competitionId: 'comp-1',
      note: 'first bout',
      taggedByAccountId: 'coach-1',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'video_clip_tag',
      details: expect.objectContaining({ action: 'video_clip_tag_added', athlete_id: 'ath-1' }),
    }));
  });

  test('a coach cannot tag an athlete who is not theirs', async () => {
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));
    const res = await post({ athlete_id: 'ath-9', event_kind: 'sparring' });
    expect(res.status).toBe(403);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('a coach cannot tag onto a video showing none of their athletes (no back door to playback)', async () => {
    mockVideo.mockResolvedValueOnce(video('ath-2'));
    mockSubjects.mockResolvedValueOnce([{ athlete_id: 'ath-3', athlete_deleted: false }]);
    mockAccessible.mockResolvedValueOnce(new Set());

    const res = await post({ athlete_id: 'ath-1', event_kind: 'sparring' });

    expect(res.status).toBe(404);
    expect(mockAccessible).toHaveBeenCalledWith(expect.anything(), ['ath-3', 'ath-2']);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('an unattributed, untagged video is open to a coach, as it is today', async () => {
    mockVideo.mockResolvedValueOnce(video(null));
    const res = await post({ athlete_id: 'ath-1', event_kind: 'sparring' });
    expect(res.status).toBe(201);
    expect(mockAccessible).not.toHaveBeenCalled();
  });

  test('a video this organization does not have is hidden', async () => {
    mockVideo.mockResolvedValueOnce(null);
    const res = await post({ athlete_id: 'ath-1', event_kind: 'sparring' });
    expect(res.status).toBe(404);
  });

  test('an organization admin may tag any video in the organization', async () => {
    mockPrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockVideo.mockResolvedValueOnce(video('ath-2'));
    const res = await post({ athlete_id: 'ath-2', event_kind: 'sparring' });
    expect(res.status).toBe(201);
    expect(mockAccessible).not.toHaveBeenCalled();
  });
});

describe('what a tag must say', () => {
  test('the athlete is required', async () => {
    const res = await post({ event_kind: 'sparring' });
    expect(res.status).toBe(400);
  });

  test('the event kind is required and has two values only -- there is no scoring kind', async () => {
    for (const eventKind of [undefined, 'scored', 'ai_rating']) {
      const res = await post({ athlete_id: 'ath-1', event_kind: eventKind });
      expect(res.status).toBe(400);
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('a malformed body is a 400, not a 500', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/pilot/video/vid-1/tags', { method: 'POST', body: '{not json' }),
      params,
    );
    expect(res.status).toBe(400);
  });
});

describe('listing a video\'s tags', () => {
  test('a coach who can see the video gets its tags', async () => {
    mockListForVideo.mockResolvedValueOnce([tagRow()]);
    const res = await GET(new NextRequest('http://localhost/api/pilot/video/vid-1/tags'), params);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });

  test('a coach who cannot see the video gets not-found', async () => {
    mockAccessible.mockResolvedValueOnce(new Set());
    const res = await GET(new NextRequest('http://localhost/api/pilot/video/vid-1/tags'), params);
    expect(res.status).toBe(404);
    expect(mockListForVideo).not.toHaveBeenCalled();
  });

  test('an athlete is refused', async () => {
    mockPrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await GET(new NextRequest('http://localhost/api/pilot/video/vid-1/tags'), params);
    expect(res.status).toBe(403);
  });
});

describe('removing a tag', () => {
  test('a coach removes a tag on their athlete, and it is audited', async () => {
    mockGetTag.mockResolvedValueOnce(tagRow());
    mockRemove.mockResolvedValueOnce(tagRow());

    const res = await del();

    expect(res.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith({ organizationId: 'org-1', tagId: 'vct-1', removedByAccountId: 'coach-1' });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ action: 'video_clip_tag_removed' }),
    }));
  });

  test('a coach cannot remove the tag on another coach\'s athlete', async () => {
    mockGetTag.mockResolvedValueOnce(tagRow({ athlete_id: 'ath-2' }));
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const res = await del();

    expect(res.status).toBe(404);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test('a tag id from another video is not found', async () => {
    mockGetTag.mockResolvedValueOnce(tagRow({ video_session_id: 'vid-2' }));
    const res = await del();
    expect(res.status).toBe(404);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  // Jason 2026-10-04: "Coach, unless consent blocks".
  test.each([
    ['GUARDIAN_CONSENT_WITHDRAWN'],
    ['GUARDIAN_CONSENT_EXCLUDES_VIDEO'],
    ['GUARDIAN_CONSENT_UNREADABLE'],
  ])('a coach cannot remove the tag of an athlete whose consent blocks video (%s)', async (code) => {
    mockGetTag.mockResolvedValueOnce(tagRow());
    mockConsent.mockRejectedValueOnce(new ConflictError('Blocked', code));

    const res = await del();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CLIP_TAG_REMOVAL_NEEDS_ADMIN');
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an organization admin removes that tag', async () => {
    mockPrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', accountId: 'admin-1' }));
    mockGetTag.mockResolvedValueOnce(tagRow());
    mockRemove.mockResolvedValueOnce(tagRow());
    mockConsent.mockRejectedValue(new ConflictError('Blocked', 'GUARDIAN_CONSENT_WITHDRAWN'));

    const res = await del();

    expect(res.status).toBe(200);
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith({ organizationId: 'org-1', tagId: 'vct-1', removedByAccountId: 'admin-1' });
  });

  test('a consent lookup fault refuses the removal rather than allowing it', async () => {
    mockGetTag.mockResolvedValueOnce(tagRow());
    mockConsent.mockRejectedValueOnce(new Error('connection reset'));

    const res = await del();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test('tag_id is required', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/pilot/video/vid-1/tags', { method: 'DELETE' }), params);
    expect(res.status).toBe(400);
  });
});
