import { NextRequest } from 'next/server';

import { POST } from './route';
import { POST as REVIEW_LINK } from '../review-link/route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getVideoSessionForReview, reviewVideoSessionScan } from '@/src/server/pilot/videoSessions';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole stays REAL so the role guard under test is the shipped one.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn().mockResolvedValue(undefined) };
});

jest.mock('@/src/server/pilot/videoSessions', () => ({
  getVideoSessionForReview: jest.fn(),
  reviewVideoSessionScan: jest.fn(),
}));

jest.mock('@/src/server/pilot/blob', () => ({ getPilotVideoSasUrl: jest.fn(() => 'https://blob/sas') }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn().mockResolvedValue(undefined) }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetVideo = getVideoSessionForReview as jest.Mock;
const mockReview = reviewVideoSessionScan as jest.Mock;
const mockAssertAthlete = assertActorCanAccessAthlete as jest.Mock;
const mockSas = getPilotVideoSasUrl as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => jest.clearAllMocks());

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function video(overrides: Record<string, unknown> = {}) {
  return {
    video_session_id: 'vs-1',
    organization_id: 'org-1',
    athlete_id: 'ath-1',
    blob_path: 'org-1/vs-1/clip.mp4',
    status: 'quarantined',
    title: 'Session tape',
    file_name: 'tape.mp4',
    scan_state: 'needs_human_review',
    scan_detail: { decision: 'needs_human_review' },
    uploaded_by_account_id: 'coach-1',
    ...overrides,
  };
}

function req(body: unknown, path = 'scan-review') {
  return new NextRequest(`http://localhost/api/pilot/video/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/pilot/video/scan-review', () => {
  test('an admin releasing a deferred video sets it ready and records who decided', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());
    mockReview.mockResolvedValue({ ...video(), status: 'ready', scan_state: 'passed' });

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve', notes: 'ordinary sparring' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decision: 'approve', status: 'ready', scan_state: 'passed' });
    expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'approve',
      // The verdict being overridden, captured BEFORE the write.
      priorScanState: 'needs_human_review',
      reviewedByAccountId: 'admin-1',
      reviewedByRole: 'organization_admin',
      notes: 'ordinary sparring',
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ action: 'video_scan_review', decision: 'approve' }),
    }));
  });

  test('blocking leaves the video quarantined', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());
    mockReview.mockResolvedValue({ ...video(), status: 'quarantined', scan_state: 'blocked' });

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'block' }));

    expect(await res.json()).toMatchObject({ status: 'quarantined', scan_state: 'blocked' });
  });

  test('a malware verdict can never be released by review', async () => {
    // The one refusal that is not a judgment call. If this ever returns 200
    // this surface has become the way a virus leaves quarantine.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video({ status: 'infected' }));

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'VIDEO_SESSION_INFECTED' });
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('an already-released video is refused rather than silently re-approved', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video({ status: 'ready', scan_state: 'passed' }));

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'VIDEO_SESSION_NOT_QUARANTINED' });
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('a blocked video can still be overridden by a human', async () => {
    // Screens produce false positives on dark or unusual footage. Gating
    // review on scan_state = needs_human_review only would leave a wrongly
    // refused video permanently unwatchable.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video({ scan_state: 'blocked' }));
    mockReview.mockResolvedValue({ ...video(), status: 'ready', scan_state: 'passed' });

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(res.status).toBe(200);
    expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({ priorScanState: 'blocked' }));
  });

  test('an environment with no scanner still has a human exit', async () => {
    // scan_state stays 'pending' forever where no gate is configured. Those
    // videos must be reviewable or that environment has no exit at all.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video({ scan_state: 'pending' }));
    mockReview.mockResolvedValue({ ...video(), status: 'ready', scan_state: 'passed' });

    expect((await POST(req({ video_session_id: 'vs-1', decision: 'approve' }))).status).toBe(200);
  });

  test('athlete access is asserted against the row, not the request', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video({ athlete_id: 'ath-real' }));
    mockReview.mockResolvedValue({ ...video(), status: 'ready' });

    await POST(req({ video_session_id: 'vs-1', decision: 'approve', athlete_id: 'ath-attacker' }));

    expect(mockAssertAthlete).toHaveBeenCalledWith(expect.anything(), 'ath-real');
  });

  test('a reviewer without access to the athlete gets 404, not 403', async () => {
    // Issue #8's disclosure rule: "exists but forbidden" must be
    // indistinguishable from "does not exist", or this route becomes a way to
    // confirm a video_session_id is real. Raised in review of #150.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());
    mockAssertAthlete.mockRejectedValueOnce(new Error('Forbidden: athlete not assigned'));

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: 'VIDEO_SESSION_NOT_FOUND' });
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('an unknown id and a forbidden one are the same response', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(null);
    const unknown = await POST(req({ video_session_id: 'vs-nope', decision: 'approve' }));

    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());
    mockAssertAthlete.mockRejectedValueOnce(new Error('Forbidden'));
    const forbidden = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(unknown.status).toBe(forbidden.status);
    expect(await unknown.json()).toEqual(await forbidden.json());
  });

  test('rejects an unrecognized decision with a message that says so', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());

    const missing = await POST(req({ video_session_id: 'vs-1' }));
    expect((await missing.json()).error).toMatch(/^Missing decision/);

    const invalid = await POST(req({ video_session_id: 'vs-1', decision: 'aprove' }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/^Unsupported decision/);
  });

  test('platform_owner cannot release an athlete video', async () => {
    // Omega is broader in breadth, strictly narrower in depth. Releasing one
    // athlete's footage is depth.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'platform_owner', accountId: 'owner-1' }));

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(res.status).toBe(403);
    expect(mockGetVideo).not.toHaveBeenCalled();
  });

  test('an athlete cannot release their own video', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));
    expect((await POST(req({ video_session_id: 'vs-1', decision: 'approve' }))).status).toBe(403);
    expect(mockGetVideo).not.toHaveBeenCalled();
  });

  test('rejects a missing or unknown decision', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());

    for (const body of [
      { video_session_id: 'vs-1' },
      { video_session_id: 'vs-1', decision: 'maybe' },
      { video_session_id: 'vs-1', decision: 'delete' },
      { decision: 'approve' },
    ]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('a video that changed state mid-review reports failure, not success', async () => {
    // The guarded UPDATE matched nothing. Returning ok here would tell the
    // reviewer their decision stuck when it did not.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());
    mockReview.mockResolvedValue(null);

    const res = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'VIDEO_SESSION_CHANGED' });
  });
});

describe('POST /api/pilot/video/review-link', () => {
  test('issues a short-lived link and audits who opened what', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());

    const res = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, url: 'https://blob/sas', expires_in_minutes: 15 });
    // The reviewer is shown what the machine concluded, so the decision is
    // informed rather than blind.
    expect(body.scan_state).toBe('needs_human_review');
    expect(mockSas).toHaveBeenCalledWith('org-1/vs-1/clip.mp4', 15);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ action: 'video_review_link_issued' }),
    }));
  });

  test('the response carrying the link is not storable by any cache', async () => {
    // The link is a bearer credential: for 15 minutes whoever holds the string
    // watches a minor's quarantined footage with no session behind it. Every
    // issuance is audited above, and a cached copy is a second holder that no
    // audit row names -- so the response must not be stored, by the browser or
    // by any intermediary on the way back.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video());

    const res = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('refuses to hand out a link for an infected file', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetVideo.mockResolvedValue(video({ status: 'infected' }));

    const res = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));

    expect(res.status).toBe(409);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('a coach may WATCH but may not overturn a refusal', async () => {
    // The deliberate asymmetry, and the reason these two routes carry
    // different role sets. #149 refuses a coach the 'blocked' override on the
    // argument that the person who filmed a session is the last one who should
    // reverse a content refusal about it -- that argument survives here. But a
    // coach must still be able to look, or the Release button #149 gave them is
    // a click made blind.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-1' }));
    mockGetVideo.mockResolvedValue(video({ scan_state: 'blocked' }));
    const link = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));
    expect(link.status).toBe(200);

    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-1' }));
    const decide = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));
    expect(decide.status).toBe(403);
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('a coach cannot mint a link for another coach\'s upload', async () => {
    // review-link must not be wider than video/[videoId]/release, which
    // requires a non-admin caller to be the uploader. Without this it was an
    // alternate playback path around "held until released". Raised in review
    // of #150.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-2' }));
    mockGetVideo.mockResolvedValue(video({ uploaded_by_account_id: 'coach-1' }));

    const res = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));

    expect(res.status).toBe(404);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('unattributed team video is not open to every coach in the org', async () => {
    // The sharper half of the same hole: with athlete_id null the athlete
    // check simply does not run, so before the uploader rule ANY coach could
    // mint a SAS for any quarantined team clip.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-2' }));
    mockGetVideo.mockResolvedValue(video({ athlete_id: null, uploaded_by_account_id: 'coach-1' }));

    const res = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));

    expect(res.status).toBe(404);
    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('the uploading coach can still watch their own quarantined upload', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-1' }));
    mockGetVideo.mockResolvedValue(video({ uploaded_by_account_id: 'coach-1' }));

    expect((await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'))).status).toBe(200);
  });

  test('an organization admin is exempt from the uploader rule', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));
    mockGetVideo.mockResolvedValue(video({ uploaded_by_account_id: 'someone-else' }));

    expect((await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'))).status).toBe(200);
  });

  test('neither surface admits a role outside the review path', async () => {
    for (const role of ['platform_owner', 'athlete', 'parent', 'board'] as const) {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));
      const link = await REVIEW_LINK(req({ video_session_id: 'vs-1' }, 'review-link'));
      mockRequirePrincipal.mockResolvedValue(principal({ role }));
      const decide = await POST(req({ video_session_id: 'vs-1', decision: 'approve' }));
      expect(link.status).toBe(403);
      expect(decide.status).toBe(403);
    }
  });
});
