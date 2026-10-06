import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  assertGuardianMediaConsent,
  checkGuardianMediaConsent,
  GuardianConsentMissingError,
} from '@/src/server/pilot/guardianConsent';
import { enqueueJob } from '@/src/server/pilot/shadowJobQueue';
import { isFilmStudyVisionConfigured } from '@/src/server/pilot/shadowFilmStudy';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';
import { assertVideoIsFilmStudyMedia } from '@/src/server/pilot/videoDestination';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';

jest.mock('@/src/server/pilot/videoClipTags', () => ({
  listLiveTagSubjects: jest.fn(),
}));
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return {
    ...actual,
    assertGuardianMediaConsent: jest.fn(),
    checkGuardianMediaConsent: jest.fn(),
  };
});
jest.mock('@/src/server/pilot/videoDestination', () => ({
  ...jest.requireActual('@/src/server/pilot/videoDestination'),
  assertVideoIsFilmStudyMedia: jest.fn(),
}));
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
const mockAssertConsent = jest.mocked(assertGuardianMediaConsent);
const mockEnqueue = jest.mocked(enqueueJob);
const mockConfigured = jest.mocked(isFilmStudyVisionConfigured);
const mockVideo = jest.mocked(getVideoSessionById);
const mockDestination = jest.mocked(assertVideoIsFilmStudyMedia);
const mockTagSubjects = jest.mocked(listLiveTagSubjects);
const mockCheckConsent = jest.mocked(checkGuardianMediaConsent);

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
  // Consent is on file unless a test says otherwise.
  mockAssertConsent.mockResolvedValue(undefined);
  mockConfigured.mockReturnValue(true);
  mockVideo.mockResolvedValue(readyVideo as never);
  mockEnqueue.mockResolvedValue('job-1' as never);
  mockTagSubjects.mockResolvedValue([]);
  // Every guardian signed, video included, unless a test says otherwise. The
  // playback scope gate (videoPlaybackConsent.ts) runs REAL against this.
  mockCheckConsent.mockImplementation(async () => signedConsent(true));
});

function signedConsent(coversVideo: boolean, status = 'signed') {
  return {
    ok: status === 'signed',
    guardianIds: ['parent-1'],
    missingParentIds: status === 'signed' ? [] : ['parent-1'],
    perGuardian: [{ parentId: 'parent-1', status, coversVideo, publicUseAllowed: false, signedAt: null }],
    retained: [],
  };
}

function consentFor(athleteId: string, result: ReturnType<typeof signedConsent>) {
  mockCheckConsent.mockImplementation(async (_org, id) => (id === athleteId ? result : signedConsent(true)));
}

describe('POST video-analysis enqueues Film Study', () => {

  /*
   * THE GUARD IS MOCKED IN THIS FILE, so without this the route could stop
   * calling it and every test here would still pass. What the guard ANSWERS is
   * decided once in src/server/pilot/videoDestination.test.ts; what each route
   * owes is that it asks.
   *
   * Four paths accept a video id without ever seeing a list, which is why
   * filtering the Film Study list was navigation rather than an invariant.
   */
  test('asks whether this footage is Film Study media before analysing it', async () => {
    await POST(post({ videoSessionId: 'vs-1' }));

    expect(mockDestination).toHaveBeenCalledWith('org-1', 'vs-1');
  });

  test('teaching footage is refused rather than queued', async () => {
    mockDestination.mockRejectedValueOnce(
      new Error('Forbidden: this footage was recorded to teach Shadow, so it cannot be used as Film Study media'),
    );

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

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

  test('checks guardian media consent for the video\'s athlete before enqueueing', async () => {
    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(202);
    expect(mockAssertConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    // Consent must be verified before the job is queued, not after.
    const consentOrder = mockAssertConsent.mock.invocationCallOrder[0];
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0];
    expect(consentOrder).toBeLessThan(enqueueOrder);
  });

  test('refuses to queue Film Study when guardian media consent is missing', async () => {
    // T-008: 'ready' only reflects the content-safety scan, not guardian
    // media consent -- the same precondition the publication approval path
    // enforces must also gate the analysis request on this footage.
    mockAssertConsent.mockRejectedValueOnce(new GuardianConsentMissingError('ATH-1', ['parent-1']));

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/guardian media consent is missing or withdrawn/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  /*
   * THE DEFECT THIS CLOSES: the video's OWN athlete was checked only by
   * assertGuardianMediaConsent, which never reads covers_video, so a
   * photo-only guardian did not stop analysis of their own child's video.
   */
  test("refuses when the video's own athlete's guardian signed photo-only", async () => {
    consentFor('ATH-1', signedConsent(false));

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(mockCheckConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("refuses when the video's own athlete's guardian withdrew consent", async () => {
    consentFor('ATH-1', signedConsent(false, 'withdrawn'));

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(mockEnqueue).not.toHaveBeenCalled();
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

/*
 * A tagged sparring or bout clip shows its other athletes to the model too
 * (owner, 2026-10-03: any tagged athlete's consent block blocks the clip).
 */
describe('POST video-analysis on a tagged clip', () => {
  const tagB = [{ athlete_id: 'ATH-2', athlete_deleted: false }];

  test("refuses when the OTHER tagged athlete's consent is missing", async () => {
    mockTagSubjects.mockResolvedValueOnce(tagB);
    mockAssertConsent.mockImplementation(async (_org, id) => {
      if (id === 'ATH-2') throw new GuardianConsentMissingError('ATH-2', ['parent-2']);
    });

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    expect(mockAssertConsent).toHaveBeenCalledWith('org-1', 'ATH-2');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("refuses when the OTHER tagged athlete's guardian withdrew", async () => {
    mockTagSubjects.mockResolvedValueOnce(tagB);
    consentFor('ATH-2', signedConsent(false, 'withdrawn'));

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("refuses when the OTHER tagged athlete's guardian signed photo-only", async () => {
    mockTagSubjects.mockResolvedValueOnce(tagB);
    consentFor('ATH-2', signedConsent(false));

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('queues when every tagged athlete has signed video consent', async () => {
    mockTagSubjects.mockResolvedValueOnce(tagB);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(202);
    expect(mockAssertConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockAssertConsent).toHaveBeenCalledWith('org-1', 'ATH-2');
    expect(mockCheckConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockCheckConsent).toHaveBeenCalledWith('org-1', 'ATH-2');
  });

  test('a deleted tagged athlete hides the clip from analysis', async () => {
    mockTagSubjects.mockResolvedValueOnce([{ athlete_id: 'ATH-2', athlete_deleted: true }]);

    const response = await POST(post({ videoSessionId: 'vs-1' }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
