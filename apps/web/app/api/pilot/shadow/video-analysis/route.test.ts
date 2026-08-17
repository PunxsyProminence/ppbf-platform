import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { assertGuardianMediaConsent, GuardianConsentMissingError } from '@/src/server/pilot/guardianConsent';
import { enqueueJob } from '@/src/server/pilot/shadowJobQueue';
import { isFilmStudyVisionConfigured } from '@/src/server/pilot/shadowFilmStudy';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));
// The real GuardianConsentMissingError class is preserved (not replaced)
// because http.ts's own jsonError does `error instanceof GuardianConsentMissingError`
// against THIS module -- mocking only assertGuardianMediaConsent keeps that
// instanceof check meaningful (same pattern as admin/video-compliance/route.test.ts).
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    assertGuardianMediaConsent: jest.fn(),
  };
});
jest.mock('@/src/server/pilot/shadowJobQueue', () => ({
  enqueueJob: jest.fn(),
  getJobStatusForActor: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowFilmStudy', () => ({
  isFilmStudyVisionConfigured: jest.fn(),
}));
jest.mock('@/src/server/pilot/videoSessions', () => ({
  getVideoSessionById: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAccess = jest.mocked(assertActorCanAccessAthlete);
const mockConsent = jest.mocked(assertGuardianMediaConsent);
const mockEnqueue = jest.mocked(enqueueJob);
const mockConfigured = jest.mocked(isFilmStudyVisionConfigured);
const mockVideo = jest.mocked(getVideoSessionById);

const readyVideo = {
  video_session_id: 'vs-1',
  organization_id: 'org-1',
  athlete_id: 'ATH-1',
  blob_path: 'org-1/vs-1.mp4',
  status: 'ready',
};

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/video-analysis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue({
    accountId: 'coach-1', organizationId: 'org-1', role: 'coach',
  } as never);
  mockAccess.mockResolvedValue(undefined as never);
  mockConsent.mockResolvedValue(undefined as never);
  mockConfigured.mockReturnValue(true);
  mockVideo.mockResolvedValue(readyVideo as never);
  mockEnqueue.mockResolvedValue('job-1' as never);
});

describe('POST video-analysis enqueues Film Study', () => {
  test('queues a job from the video session row, not from caller input', async () => {
    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, jobId: 'job-1', status: 'queued' });

    // Athlete, blob path and subject scope all come from the row.
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ATH-1');
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      jobType: 'film_study',
      organizationId: 'org-1',
      subjectId: 'ATH-1',
      inputPayload: expect.objectContaining({
        videoSessionId: 'vs-1',
        athleteId: 'ATH-1',
        blobPath: 'org-1/vs-1.mp4',
      }),
    }));
  });

  test('a caller-supplied athlete or blob path is ignored entirely', async () => {
    await POST(post({
      videoSessionId: 'vs-1',
      athleteId: 'ATH-SOMEBODY-ELSE',
      blobPath: '../../etc/passwd',
      videoUrl: 'https://attacker.example/clip.mp4',
    }));

    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ATH-1');
    const payload = mockEnqueue.mock.calls[0][0].inputPayload;
    expect(payload.athleteId).toBe('ATH-1');
    expect(payload.blobPath).toBe('org-1/vs-1.mp4');
  });

  test('refuses before enqueueing when the vision deployment is unset', async () => {
    // Queueing work no executor can perform is how jobs end up pending
    // forever; the honest answer is to refuse now.
    mockConfigured.mockReturnValue(false);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'SHADOW_FILM_VISION_UNCONFIGURED',
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('refuses to queue analysis when guardian media consent is missing or withdrawn', async () => {
    // 'ready' only reflects the content/malware scan, not consent -- a
    // vision pass over the footage needs its own check, same as the
    // publication-approval path.
    mockConsent.mockRejectedValue(new GuardianConsentMissingError('ATH-1', ['parent-1']));

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('checks consent after access, before the readiness check', async () => {
    await POST(post({ videoSessionId: 'vs-1' }));

    expect(mockAccess).toHaveBeenCalled();
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockEnqueue).toHaveBeenCalled();
  });

  test('refuses a video that has not been scanned', async () => {
    // Uploads are born 'quarantined' (#125); the worker must never open an
    // unscanned or infected file.
    mockVideo.mockResolvedValue({ ...readyVideo, status: 'quarantined' } as never);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: 'VIDEO_SESSION_NOT_READY' });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('refuses a video with no athlete', async () => {
    mockVideo.mockResolvedValue({ ...readyVideo, athlete_id: null } as never);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(400);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a video from another organization is not found', async () => {
    mockVideo.mockResolvedValue(null as never);

    const response = await POST(post({ videoSessionId: 'vs-elsewhere' }));

    expect(response.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('missing videoSessionId is a 400', async () => {
    const response = await POST(post({}));
    expect(response.status).toBe(400);
    expect(mockVideo).not.toHaveBeenCalled();
  });

  // Requesting analysis of one athlete's video is depth, and Omega is
  // broader in breadth but strictly narrower in depth (shadowRoleSets.ts).
  test('platform_owner is refused', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'omega-1', organizationId: 'org-1', role: 'platform_owner',
    } as never);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('an athlete cannot request analysis', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'ath-1', organizationId: 'org-1', role: 'athlete',
    } as never);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
