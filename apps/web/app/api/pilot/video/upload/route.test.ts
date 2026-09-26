import { NextRequest } from 'next/server';

import { POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

/*
 * TS-ANON-01. Teaching uploads resolve their subject server-side from the
 * capture session and re-check consent before the footage is accepted.
 * Doubled here so these tests exercise the route's rules; the resolver and
 * the consent gate each have their own suites.
 */
jest.mock('@/src/server/pilot/captureParticipants', () => ({
  participantsForSession: jest.fn(async () => ['cp-1']),
  athleteIdsForParticipants: jest.fn(async () => ['ath-1']),
  linkParticipantToVideo: jest.fn(async () => undefined),
}));
jest.mock('@/src/server/pilot/guardianConsent', () => {
  const actual = jest.requireActual('@/src/server/pilot/guardianConsent');
  return { ...actual, assertTeachShadowConsent: jest.fn(async () => undefined) };
});
jest.mock('@/src/server/pilot/blob', () => ({
  uploadPilotVideoFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/shadowEvents', () => ({
  emitShadowEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/shadowTelemetry', () => ({
  writeShadowTelemetryEvent: jest.fn().mockResolvedValue(undefined),
}));

// Only the enforcer is mocked; the pure resolver and message helper stay REAL so
// the route applies the same limits it ships with.
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn().mockResolvedValue(undefined) };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
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

function uploadRequest(fields: Record<string, string | Blob>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest('http://localhost/api/pilot/video/upload', {
    method: 'POST',
    body: formData,
    headers: { 'content-length': '4096' },
  });
}

const videoFile = () => new File(
  [new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])],
  'clip.mp4',
  { type: 'video/mp4' },
);

describe('POST /api/pilot/video/upload', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot upload', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete' }));
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(403);
  });

  test('400 when file is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await POST(uploadRequest({ title: 'no file here' }));
    expect(res.status).toBe(400);
  });

  test('415 for unsupported mime type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const badFile = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });
    const res = await POST(uploadRequest({ file: badFile }));
    expect(res.status).toBe(415);
  });

  test('415 when the bytes do not match the declared video type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const spoofed = new File(
      [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])],
      'spoofed.mp4',
      { type: 'video/mp4' },
    );
    const res = await POST(uploadRequest({ file: spoofed }));
    expect(res.status).toBe(415);
  });

  test('403 when coach uploads for an unassigned athlete (coach-assignment enforcement)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('202 when coach uploads for an assigned athlete into quarantine', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(expect.objectContaining({
      status: 'quarantined',
      accepted_for_security_review: true,
    }));
  });

  test('the upload response says whether anything will actually scan the video', async () => {
    // Before #49 nothing in the platform could move a video off 'quarantined',
    // yet this response reported it accepted for security review. The claim
    // has to track the environment.
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([]);
    const withoutScanner = await (await POST(uploadRequest({ file: videoFile() }))).json();
    expect(withoutScanner.scan_pending).toBe(false);
    expect(withoutScanner.message).toMatch(/no video scanner is configured/i);

    process.env.PPBF_VIDEO_CONTENT_SCAN = 'vision';
    try {
      mockRequirePrincipal.mockResolvedValueOnce(principal({}));
      mockQuery.mockResolvedValueOnce([]);
      const withScanner = await (await POST(uploadRequest({ file: videoFile() }))).json();
      expect(withScanner.scan_pending).toBe(true);
      expect(withScanner.message).toMatch(/until an automated scan clears it/i);
    } finally {
      delete process.env.PPBF_VIDEO_CONTENT_SCAN;
    }
  });

  test('202 when coach uploads an unattributed (team) video with no athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([]);
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(202);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('403 when organization_admin uploads for an athlete outside their organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-other-org' }));
    expect(res.status).toBe(403);
  });
});

/*
 * CAP-VID-01. The capture surface sends a take; these are the refusals that
 * stop it producing footage the rest of the platform would mishandle.
 */
describe('a capture recording carries its take and its subject', () => {
  const OPEN_TAKE = [{ recording_session_id: 'rs-1', state: 'open' }];

  /*
   * The real coach-assignment check runs in these cases -- it is not stubbed,
   * because two tests above prove it REFUSES and stubbing it here would quietly
   * weaken them. queryOne answers that check with an assigned athlete, the same
   * way the existing 202 case does; query then answers the take lookup.
   */
  function assignedAthlete() {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
  }

  /*
   * THE SAFEGUARDING REFUSAL. videoScanSweep only asserts guardian consent
   * when a video names an athlete -- a video with none "has no guardian to
   * ask". A dedicated learning-capture UI that filmed a minor and stored them
   * unattributed would therefore enter the vision content screen with that
   * check skipped. Refused on the server, so a client cannot simply omit it.
   */
  test('TS-ANON-01 -- a recording that NAMES an athlete is refused, because teaching media is anonymous', async () => {
    /*
     * THE RULE INVERTED BY OWNER DECISION. This test previously asserted the
     * opposite: that a take-backed recording without an athlete was refused.
     * Teaching media now names nobody, and the identifier is refused rather
     * than quietly stripped -- silently accepting it would leave a stale
     * client believing it had attributed the footage, and an identifier
     * arriving at this boundary with nothing to say it was ignored.
     */
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce(OPEN_TAKE);

    const response = await POST(uploadRequest({
      file: videoFile(),
      capture_take_id: 'take-1',
      athlete_id: 'ath-1',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/anonymous/i) });
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('insert into pilot.video_sessions'))).toBe(false);
  });

  test('an ordinary ungrouped upload still needs no athlete -- this refusal is scoped to capture', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const response = await POST(uploadRequest({ file: videoFile(), title: 'Team drill' }));

    expect(response.status).toBe(202);
  });

  /*
   * THE FILM STUDY RECORDER SENDS NO TAKE, ON PURPOSE -- a takeless upload is
   * what keeps its footage out of the recognition corpus. So the safeguarding
   * refusal cannot be keyed on take-presence: it is keyed on capture_source,
   * which says a dedicated recorder produced the bytes. Without these two, a
   * recorder could film a minor and store them unattributed, and the guardian
   * consent check videoScanSweep runs only for videos that name an athlete
   * would never fire.
   */
  test('a Film Study recording carries no take, and is still refused without an athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const response = await POST(
      uploadRequest({ file: videoFile(), capture_source: 'in_app_recording' }),
    );

    expect(response.status).toBe(400);
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('insert into pilot.video_sessions'))).toBe(false);
  });

  test('a Film Study recording that names its athlete is stored with no recognition session or take', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();

    const response = await POST(
      uploadRequest({
        file: videoFile(),
        athlete_id: 'ath-1',
        capture_source: 'in_app_recording',
      }),
    );

    expect(response.status).toBe(202);
    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('insert into pilot.video_sessions'));
    const params = insert?.[1] as unknown[];
    // recording_session_id, capture_take_id and the per-view identity. All
    // null is the whole Film Study contract: nothing here can join a take, so
    // nothing here can become corpus evidence.
    expect([params[10], params[11], params[12]]).toEqual([null, null, null]);
    expect(params[3]).toBe('ath-1');
    expect(params[15]).toBe('in_app_recording');
  });

  test('a take from another organization is not found, and nothing is stored', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce([]);

    const response = await POST(
      uploadRequest({ file: videoFile(), capture_take_id: 'take-elsewhere', athlete_id: 'ath-1' }),
    );

    expect(response.status).toBe(404);
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('insert into pilot.video_sessions'))).toBe(false);
  });

  test('a closed take is refused rather than silently attaching to a finished attempt', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce([{ recording_session_id: 'rs-1', state: 'closed' }]);

    const response = await POST(
      uploadRequest({ file: videoFile(), capture_take_id: 'take-1', athlete_id: 'ath-1' }),
    );

    expect(response.status).toBe(409);
  });

  /*
   * An angle chosen from the device is still an angle of this attempt, and
   * must not be labelled as something this app recorded. capture_source is
   * therefore declared rather than inferred from the presence of a take.
   */
  test('capture_source is taken from the request, so a chosen file is not called an in-app recording', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce(OPEN_TAKE);

    const response = await POST(
      uploadRequest({
        file: videoFile(),
        capture_take_id: 'take-1',
        capture_source: 'file_upload',
      }),
    );

    expect(response.status).toBe(202);
    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('insert into pilot.video_sessions'));
    expect(insert?.[1]).toContain('file_upload');
  });

  test('an invented capture_source is refused rather than reaching the column check', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce(OPEN_TAKE);

    const response = await POST(
      uploadRequest({
        file: videoFile(),
        capture_take_id: 'take-1',
        athlete_id: 'ath-1',
        capture_source: 'telepathy',
      }),
    );

    expect(response.status).toBe(400);
  });

  test('a recorded angle stores the session resolved from the take, never one the client named', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce(OPEN_TAKE);

    const response = await POST(
      uploadRequest({
        file: videoFile(),
        capture_take_id: 'take-1',
        capture_source: 'in_app_recording',
        recording_session_id: 'rs-somebody-elses',
      }),
    );

    expect(response.status).toBe(202);
    const insert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('insert into pilot.video_sessions'));
    expect(insert?.[1]).toContain('rs-1');
    expect(insert?.[1]).not.toContain('rs-somebody-elses');
  });

  test('an out-of-calendar recorded_at is refused rather than reaching a timestamptz column', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    assignedAthlete();
    mockQuery.mockResolvedValueOnce(OPEN_TAKE);

    const response = await POST(
      uploadRequest({
        file: videoFile(),
        capture_take_id: 'take-1',
        athlete_id: 'ath-1',
        recorded_at: '2026-02-30T12:00:00.000Z',
      }),
    );

    expect(response.status).toBe(400);
  });
});
