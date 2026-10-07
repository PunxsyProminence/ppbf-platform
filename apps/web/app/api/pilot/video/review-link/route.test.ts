import { NextRequest } from 'next/server';

import { POST } from './route';
import { accessibleAthleteIds } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { ConflictError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';
import { assertConsentCoversVideo, mintUnderPlaybackConsent } from '@/src/server/pilot/videoPlaybackConsent';
import { authorizeVideoScanReview, VideoScanReviewRefused } from '@/src/server/pilot/videoScanReview';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The entitlement and quarantine-state rules have their own suite; this one
// exercises what the ROUTE adds on top of them.
jest.mock('@/src/server/pilot/videoScanReview', () => ({
  ...jest.requireActual('@/src/server/pilot/videoScanReview'),
  authorizeVideoScanReview: jest.fn(),
}));
// mintUnderPlaybackConsent's transaction and locking have their own suite;
// here it asks the doubled consent check for each athlete, then mints.
jest.mock('@/src/server/pilot/videoPlaybackConsent', () => {
  const assertConsentCoversVideo = jest.fn().mockResolvedValue(undefined);
  return {
    assertConsentCoversVideo,
    mintUnderPlaybackConsent: jest.fn(async (organizationId: string, athleteIds: string[], mint: () => unknown) => {
      for (const athleteId of athleteIds) await assertConsentCoversVideo(organizationId, athleteId);
      return mint();
    }),
  };
});
jest.mock('@/src/server/pilot/blob', () => ({
  getPilotVideoSasUrl: jest.fn(() => 'https://blob.example/vid-1?sig=x'),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
// Untagged unless a test tags the clip; the SQL has its own pg suite.
jest.mock('@/src/server/pilot/videoClipTags', () => ({ listLiveTagSubjects: jest.fn(async () => []) }));
// Only the batched reach check is doubled; requireRole and
// isOrganizationAdminRole stay real. The coach reaches every athlete asked
// about unless a test says otherwise. Its SQL has access.ts's own suites.
const reachesEveryone = async (_actor: unknown, ids: readonly string[]) => new Set(ids);
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  accessibleAthleteIds: jest.fn(async (_actor: unknown, ids: readonly string[]) => new Set(ids)),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockReach = accessibleAthleteIds as jest.Mock;
const mockAuthorize = authorizeVideoScanReview as jest.Mock;
const mockConsent = assertConsentCoversVideo as jest.Mock;
const mockMint = mintUnderPlaybackConsent as jest.Mock;
const mockSas = getPilotVideoSasUrl as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockTags = listLiveTagSubjects as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps implementations; the tagged-clip tests below install
  // a per-athlete one, which must not leak into the next test.
  mockConsent.mockReset().mockResolvedValue(undefined);
  mockTags.mockReset().mockResolvedValue([]);
  mockReach.mockReset().mockImplementation(reachesEveryone);
});

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

const quarantined = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  blob_path: 'org-1/vid-1.mp4',
  title: 'Sparring',
  file_name: 'vid-1.mp4',
  scan_state: 'blocked',
  scan_detail: null,
  ...overrides,
});

function call(body: unknown = { video_session_id: 'vid-1' }) {
  return POST(new NextRequest('http://localhost/api/pilot/video/review-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/*
 * CL-A21, Jason 2026-10-06: "No one watches it". A guardian's photo-only,
 * withdrawn or unreadable media consent refuses the review link too, the same
 * gate playback, publication and the automated scan use
 * (OD-2026-10-05-016/-021/-022). The footage stays quarantined; Block still
 * works without viewing.
 */
describe('POST /api/pilot/video/review-link', () => {
  test.each([
    ['photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'],
    ['withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'],
    ['unreadable', 'GUARDIAN_CONSENT_UNREADABLE'],
  ])('a %s consent refuses the link and mints nothing', async (_label, code) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockConsent.mockRejectedValueOnce(new ConflictError('Blocked: consent', code));

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(body.error).toEqual(expect.any(String));
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-1'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('consent is asked only after the entitlement check, so a refusal never confirms a video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockRejectedValueOnce(new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404));

    const res = await call();

    expect(res.status).toBe(404);
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('consent that covers video issues the 15-minute link and audits it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, url: 'https://blob.example/vid-1?sig=x', expires_in_minutes: 15 });
    expect(mockSas).toHaveBeenCalledWith('org-1/vid-1.mp4', 15);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('teaching footage names nobody, so there is no guardian to ask', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined({ athlete_id: null }));

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith('org-1', [], expect.any(Function));
    expect(mockConsent).not.toHaveBeenCalled();
  });

  test('the organization admin is held to the same consent refusal', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockConsent.mockRejectedValueOnce(new ConflictError('Blocked: consent', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockSas).not.toHaveBeenCalled();
  });
});

/*
 * EVERY CHILD THE CLIP SHOWS. A sparring clip is filed under one athlete and
 * tagged to the others in it (videoClipTags.ts; owner, Jason 2026-10-03: any
 * tagged athlete's consent block blocks the whole clip, for everyone). The
 * route used to ask only the clip's own athlete, so a reviewer could watch a
 * clip showing a tagged child whose guardian had said no. CL-A21 ("No one
 * watches it") applies to that child too.
 *
 * The consent double refuses PER ATHLETE here: the clip's own athlete passes
 * and only the tagged partner refuses, so each test proves the partner's
 * answer alone is enough to refuse the link.
 */
describe('POST /api/pilot/video/review-link on a tagged clip', () => {
  const taggedClip = () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockTags.mockResolvedValueOnce([{ athlete_id: 'ath-tagged', athlete_deleted: false }]);
  };
  const partnerRefuses = (error: ConflictError) => {
    mockConsent.mockImplementation(async (_org: string, athleteId: string) => {
      if (athleteId === 'ath-tagged') throw error;
    });
  };

  test.each([
    ['withdrew consent', new ConflictError(
      "Blocked: 1 of this athlete's guardians has withdrawn media consent.", 'GUARDIAN_CONSENT_WITHDRAWN',
    )],
    ['signed photo-only', new ConflictError(
      "Blocked: 1 of this athlete's guardians signed a photo-only media consent that does not cover video.",
      'GUARDIAN_CONSENT_EXCLUDES_VIDEO',
    )],
    // OD-2026-10-05-023 "Keep the 'no'": a purged guardian's last answer
    // still refuses (assertConsentCoversVideo's retained loop, proven in its
    // own suite); the route owes that the tagged child is asked at all.
    ['has a deleted guardian whose last answer was no', new ConflictError(
      'Blocked: a former guardian of this athlete, whose account has since been deleted, withdrew media consent.',
      'GUARDIAN_CONSENT_WITHDRAWN',
    )],
  ])('a tagged child whose guardian %s refuses the link, even though the clip\'s own athlete consents', async (_label, error) => {
    taggedClip();
    partnerRefuses(error);

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(error.code);
    // Both children were asked, inside the one mint call.
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-tagged');
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    // The refusal says the whole clip is blocked while any athlete in it is,
    // and never which one: the partner may be a child this coach cannot see.
    expect(body.error).toContain('This clip shows more than one athlete');
    expect(body.error).not.toContain('ath-tagged');
    expect(body.error).not.toContain('ath-1');
  });

  test('a clip whose every athlete consents to video issues the link', async () => {
    taggedClip();

    const res = await call();

    expect(res.status).toBe(200);
    // The tags of THIS clip, in this organization: two swapped strings would
    // read nothing and silently ask only the clip's own athlete again.
    expect(mockTags).toHaveBeenCalledWith('org-1', 'vid-1');
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledTimes(2);
    expect(mockSas).toHaveBeenCalledTimes(1);
  });

  test('a tag read that fails is a failure, not an untagged clip: nothing is minted', async () => {
    // "We could not find out who is in the clip, so ask only the one it is
    // filed under" is the fail-open direction a consent read must never take.
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockTags.mockRejectedValueOnce(new Error('connection reset'));

    const res = await call();

    expect(res.status).toBe(500);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a tag naming a deleted athlete reads as not found, as on playback, and asks nobody', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockTags.mockResolvedValueOnce([
      { athlete_id: 'ath-tagged', athlete_deleted: false },
      { athlete_id: 'ath-gone', athlete_deleted: true },
    ]);

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: 'VIDEO_SESSION_NOT_FOUND' });
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a tag naming the clip\'s own athlete is asked once', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined());
    mockTags.mockResolvedValueOnce([
      { athlete_id: 'ath-1', athlete_deleted: false },
      { athlete_id: 'ath-tagged', athlete_deleted: false },
    ]);

    expect((await call()).status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
  });

  test('an unattributed clip with tags asks the tagged children', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined({ athlete_id: null }));
    mockTags.mockResolvedValueOnce([{ athlete_id: 'ath-tagged', athlete_deleted: false }]);
    partnerRefuses(new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'));

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-tagged'], expect.any(Function));
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('tags are read only after the entitlement check, so a tag\'s not-found never confirms a video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockRejectedValueOnce(new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404));

    expect((await call()).status).toBe(404);
    expect(mockTags).not.toHaveBeenCalled();
  });
});

/*
 * AND THE COACH MUST REACH AT LEAST ONE CHILD THE CLIP SHOWS. The entitlement
 * check (authorizeVideoScanReview, doubled here) sees the uploader and the
 * clip's own athlete, never the tags. Playback refuses a tagged clip to a coach
 * who reaches none of the athletes in it (video/[videoId]/route.ts,
 * accessibleAthleteIds); this route now does the same, before consent is
 * asked, so the consent 409 can no longer tell a coach about a child they
 * cannot see (coach reads are for the coach of record, a live covering coach
 * or an organization admin: OD-2026-10-05-024 item 2).
 *
 * The scenario each test is built from: coach C uploaded untagged team footage
 * (athlete_id null, so the entitlement check had no athlete to ask about),
 * coach D tagged child X, whom C does not coach.
 */
describe('POST /api/pilot/video/review-link reach on a tagged clip', () => {
  const uploaderOfTeamFootageTaggedByAnother = (overrides: Record<string, unknown> = { athlete_id: null }) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined(overrides));
    mockTags.mockResolvedValueOnce([{ athlete_id: 'ath-tagged', athlete_deleted: false }]);
  };

  test('a coach who reaches no athlete in the clip is refused as not found and learns nothing about consent', async () => {
    uploaderOfTeamFootageTaggedByAnother();
    mockReach.mockResolvedValueOnce(new Set());
    // The tagged child's guardian refused: the one fact this coach must not
    // be able to read off the response.
    mockConsent.mockRejectedValue(new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN'));

    const res = await call();

    expect(res.status).toBe(404);
    // Byte-for-byte the refusal authorizeVideoScanReview gives a caller who
    // may not know the video exists: no code, no consent wording.
    expect(await res.json()).toEqual({ error: 'Not found', reason: 'VIDEO_SESSION_NOT_FOUND' });
    expect(mockReach).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1', role: 'coach' }), ['ath-tagged']);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the reach question names every athlete the clip shows, own athlete included', async () => {
    uploaderOfTeamFootageTaggedByAnother({ athlete_id: 'ath-1' });

    expect((await call()).status).toBe(200);
    expect(mockReach).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1' }), ['ath-1', 'ath-tagged']);
  });

  test('a coach who reaches at least one athlete in the clip is handled as before: every child asked, link issued', async () => {
    uploaderOfTeamFootageTaggedByAnother({ athlete_id: 'ath-1' });
    // Reaches the clip's own athlete only, not the tagged partner -- enough,
    // as on playback.
    mockReach.mockResolvedValueOnce(new Set(['ath-1']));

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-tagged');
    expect(mockSas).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('a coach who reaches at least one athlete still gets the clip-wide consent refusal, naming nobody', async () => {
    uploaderOfTeamFootageTaggedByAnother({ athlete_id: 'ath-1' });
    mockReach.mockResolvedValueOnce(new Set(['ath-1']));
    mockConsent.mockImplementation(async (_org: string, athleteId: string) => {
      if (athleteId === 'ath-tagged') throw new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN');
    });

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(body.error).toContain('This clip shows more than one athlete');
    expect(body.error).not.toContain('ath-tagged');
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('an organization admin is not asked to reach: they reach every athlete in the organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockAuthorize.mockResolvedValueOnce(quarantined({ athlete_id: null }));
    mockTags.mockResolvedValueOnce([{ athlete_id: 'ath-tagged', athlete_deleted: false }]);
    mockReach.mockResolvedValueOnce(new Set());

    expect((await call()).status).toBe(200);
    expect(mockReach).not.toHaveBeenCalled();
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-tagged');
  });

  test('an untagged clip is not asked: the uploader rule decided it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAuthorize.mockResolvedValueOnce(quarantined({ athlete_id: null }));
    mockReach.mockResolvedValueOnce(new Set());

    expect((await call()).status).toBe(200);
    expect(mockReach).not.toHaveBeenCalled();
    expect(mockMint).toHaveBeenCalledWith('org-1', [], expect.any(Function));
  });

  test('a reach read that fails is a failure, not a reach: nothing is minted', async () => {
    uploaderOfTeamFootageTaggedByAnother();
    mockReach.mockRejectedValueOnce(new Error('connection reset'));

    expect((await call()).status).toBe(500);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
