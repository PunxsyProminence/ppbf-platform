import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { ConflictError } from '@/src/server/pilot/errors';
import { assertConsentCoversVideo, writeUnderPlaybackConsent } from '@/src/server/pilot/videoPlaybackConsent';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getVideoReleasePolicy } from '@/src/server/pilot/videoReleasePolicy';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';
import { assertActorHoldsCurrentReviewLink } from '@/src/server/pilot/videoScanReview';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

// Doubled so this suite exercises the ROUTE, not the policy lookup -- which
// has its own database-backed suite. Defaults to the strict posture, so every
// pre-existing assertion here still describes an unconfigured organization.
jest.mock('@/src/server/pilot/videoReleasePolicy', () => {
  const actual = jest.requireActual('@/src/server/pilot/videoReleasePolicy');
  return {
    ...actual,
    getVideoReleasePolicy: jest.fn(async () => 'scan_required'),
  };
});
jest.mock('@/src/server/pilot/videoScanReview', () => ({
  ...jest.requireActual('@/src/server/pilot/videoScanReview'),
  assertActorHoldsCurrentReviewLink: jest.fn(),
}));
// The write runs under writeUnderPlaybackConsent (from #1286): the consent
// check for every named athlete, then the write on the held transaction. The
// transaction itself is proven against Postgres in
// playbackConsentRace.pg.test.ts (mintUnderPlaybackConsent delegates to it).
// Here the double keeps the ORDER (check, then write) and, when there are
// subjects, hands the write a sentinel client that forwards to the pooled
// queryOne double -- so the assertions can see both that the UPDATE went
// through the transaction's client and what it said.
const TX_CLIENT = {
  query: jest.fn(async (sql: string, params?: unknown[]) => {
    const { queryOne } = jest.requireMock('@/src/server/pilot/db');
    const row = await queryOne(sql, params);
    return { rows: row ? [row] : [] };
  }),
};
jest.mock('@/src/server/pilot/videoPlaybackConsent', () => ({
  assertConsentCoversVideo: jest.fn().mockResolvedValue(undefined),
  writeUnderPlaybackConsent: jest.fn(async (org: string, ids: string[], write: (client: unknown) => unknown) => {
    const { assertConsentCoversVideo } = jest.requireMock('@/src/server/pilot/videoPlaybackConsent');
    for (const id of ids) await assertConsentCoversVideo(org, id);
    return write(ids.length > 0 ? TX_CLIENT : null);
  }),
}));
// Only the athlete-reach check is doubled; requireRole and
// isOrganizationAdminRole stay real.
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));
// Untagged unless a test tags the clip; the SQL has its own pg suite.
jest.mock('@/src/server/pilot/videoClipTags', () => ({ listLiveTagSubjects: jest.fn(async () => []) }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockPrereq = assertActorHoldsCurrentReviewLink as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockConsent = assertConsentCoversVideo as jest.Mock;
const mockTags = listLiveTagSubjects as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps implementations; the tagged-clip tests install a
  // per-athlete one, which must not leak into the next test.
  mockConsent.mockReset().mockResolvedValue(undefined);
  mockTags.mockReset().mockResolvedValue([]);
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

const videoRow = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  status: 'quarantined',
  // The scan sweep promotes what it can clear itself, so the rows that reach
  // this route are the ones it handed back to a person.
  scan_state: 'needs_human_review',
  athlete_id: 'ath-1',
  uploaded_by_account_id: 'coach-1',
  ...overrides,
});

function call(videoId = 'vid-1') {
  const request = new NextRequest(`http://localhost/api/pilot/video/${videoId}/release`, { method: 'POST' });
  return POST(request, { params: Promise.resolve({ videoId }) });
}

// Releasing is what makes a video playable to an athlete and their guardians,
// so who may do it, and from which state, are the two properties this route
// exists to hold.
describe('POST /api/pilot/video/[videoId]/release', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board'] as const)(
    '%s cannot release a video',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: 'ath-1' }));
      const res = await call();
      expect(res.status).toBe(403);
      expect(mockQueryOne).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  /*
   * THE PREREQUISITE IS MOCKED IN THIS FILE, so without these the route could
   * stop calling it and every test here would still pass. What it ANSWERS is
   * decided in src/server/pilot/videoReviewPrerequisite.test.ts, including the
   * three negative controls; what this route owes is that it asks, and that a
   * refusal actually stops the write.
   */
  test('the write is bound to the exact verdict that was reviewed, not to any releasable one', async () => {
    /*
     * THE RACE THIS CLOSES. The prerequisite proves the actor holds a link
     * issued against the verdict this row carried when it was read. If a
     * re-scan changes that verdict before the write, a predicate of
     * `scan_state = any(releasable)` would still accept it -- and the release
     * would land on a review of a verdict that no longer holds, which is what
     * binding the link to the scan state was for.
     */
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    await call();

    const [updateSql, updateParams] = mockQueryOne.mock.calls[1];
    expect(String(updateSql)).toContain('scan_state = $3');
    expect(String(updateSql)).not.toContain('any(');
    expect(updateParams[2]).toBe('needs_human_review');
  });

  test('a verdict that changed under the reviewer is a conflict, not a release', async () => {
    // The guarded UPDATE matches nothing, and the route already has the right
    // answer for that: reload and try again.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null);

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a release asks whether this actor holds a current review link', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    await call();

    expect(mockPrereq).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'coach-1' }),
      'vid-1',
      // The row's OWN verdict, passed through -- which is what binds the
      // review link to the state the actor is deciding on.
      'needs_human_review',
    );
  });

  test('without a review link nothing is written, not merely refused', async () => {
    // A refusal that still flipped the row to 'ready' would be no refusal.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockPrereq.mockRejectedValueOnce(
      new Error('Forbidden: open the review link for this footage before releasing it'),
    );

    const res = await call();

    expect(res.status).toBe(403);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the uploading coach releases their own video and the release is audited', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, video_session_id: 'vid-1', status: 'ready' });

    const [updateSql, updateParams] = mockQueryOne.mock.calls[1];
    expect(updateSql).toContain("set status = 'ready'");
    expect(updateSql).toContain("status = 'quarantined'");
    expect(updateParams.slice(0, 2)).toEqual(['vid-1', 'org-1']);

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: 'org-1',
      entity_type: 'video_session',
      entity_id: 'vid-1',
      details: expect.objectContaining({ action: 'video_release', to_status: 'ready' }),
    }));
  });

  test('the read and the write are both scoped to the acting organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ organizationId: 'org-1' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    await call();

    expect(mockQueryOne.mock.calls[0][1]).toEqual(['vid-1', 'org-1']);
    // The write carries the releasable scan states as well, so the organization
    // scope and the scan verdict are both re-checked at write time.
    expect(mockQueryOne.mock.calls[1][1].slice(0, 2)).toEqual(['vid-1', 'org-1']);
  });

  test('a video from another organization returns hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await call('vid-other-org');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a coach who did not upload the video gets the same hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-2' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ uploaded_by_account_id: 'coach-1' }));

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // CL-A21: having uploaded footage is not a standing claim on the athlete in
  // it. A coach who has since lost the assignment cannot release it.
  test('the uploading coach who no longer reaches the athlete gets hidden not-found and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1' }), 'ath-1');
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockPrereq).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('teaching footage names nobody, so the uploader rule alone applies to its release', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow({ athlete_id: null }))
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  // CL-A21 follow-through: a review link minted before a guardian went
  // photo-only or withdrew still satisfies the prerequisite for 15 minutes,
  // so the release asks consent again rather than putting the footage into
  // circulation after the guardian said no.
  test('consent that no longer covers video refuses the release and writes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockConsent.mockRejectedValueOnce(new ConflictError('Blocked: photo-only', 'GUARDIAN_CONSENT_EXCLUDES_VIDEO'));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // From #1286: checked on the pool and then written on the pool, a
  // withdrawal could commit between the two and the release still landed.
  // The write now runs inside the consent check's own transaction.
  test('the release write runs under the consent transaction for the named athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
    const mockWrite = writeUnderPlaybackConsent as jest.Mock;
    expect(mockWrite).toHaveBeenCalledWith('org-1', ['ath-1'], expect.any(Function));
    // The UPDATE was issued on the transaction's client, not on the pool: a
    // route that checked consent in the helper and then wrote on the pool
    // afterwards would fail here.
    expect(TX_CLIENT.query).toHaveBeenCalledTimes(1);
    expect(String(TX_CLIENT.query.mock.calls[0][0])).toContain("set status = 'ready'");
    expect(TX_CLIENT.query.mock.calls[0][1]).toEqual(['vid-1', 'org-1', 'needs_human_review']);
  });

  test('unattributed footage names nobody, so the write runs with no consent subjects', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow({ athlete_id: null }))
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(writeUnderPlaybackConsent).toHaveBeenCalledWith('org-1', [], expect.any(Function));
    expect(mockConsent).not.toHaveBeenCalled();
    // No client, so the pooled write ran.
    expect(TX_CLIENT.query).not.toHaveBeenCalled();
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  test('an organization admin is not put through the coach assignment check', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow({ uploaded_by_account_id: 'coach-2' }))
      .mockResolvedValueOnce({ status: 'ready' });

    expect((await call()).status).toBe(200);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  test('an organization admin can release a video another account uploaded', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', accountId: 'admin-1' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow({ uploaded_by_account_id: 'coach-1' }))
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
  });

  test.each(['infected', 'error', 'archived', 'processing', 'uploaded'])(
    'a video in %s is never released',
    async (status) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({}));
      mockQueryOne.mockResolvedValueOnce(videoRow({ status }));

      const res = await call();

      expect(res.status).toBe(409);
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test('an already released video is refused with a reason rather than re-audited', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow({ status: 'ready' }));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already been released');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('losing the race to another release writes no audit record', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null);

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

/*
 * EVERY CHILD THE CLIP SHOWS. A sparring clip is filed under one athlete and
 * tagged to the others in it (videoClipTags.ts; owner, Jason 2026-10-03: any
 * tagged athlete's consent block blocks the whole clip, for everyone). The
 * route used to ask only the clip's own athlete, so a coach could release a
 * clip showing a tagged child whose guardian had said no.
 *
 * The consent double refuses PER ATHLETE: the clip's own athlete passes and
 * only the tagged partner refuses, so each test proves the partner's answer
 * alone stops the release -- and that it was asked inside the write's
 * transaction (the sentinel client), not on the pool afterwards.
 */
describe('releasing a tagged clip', () => {
  // The UPDATE's result is queued only when the test expects the write to
  // run: clearAllMocks does not drop a queued mockResolvedValueOnce, so one
  // left unconsumed by a refusal test would be read as the NEXT test's row.
  const taggedClip = (overrides: Record<string, unknown> = {}, { written = true } = {}) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow(overrides));
    if (written) mockQueryOne.mockResolvedValueOnce({ status: 'ready' });
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
  ])('a tagged child whose guardian %s refuses the release and nothing is written', async (_label, error) => {
    taggedClip({}, { written: false });
    partnerRefuses(error);

    const res = await call();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(error.code);
    expect(writeUnderPlaybackConsent).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-tagged');
    // One read, no UPDATE on either the pool or the transaction.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(TX_CLIENT.query).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    // The refusal says the whole clip is blocked while any athlete in it is,
    // and never which one: the partner may be a child this coach cannot see.
    expect(body.error).toContain('This clip shows more than one athlete');
    expect(body.error).not.toContain('ath-tagged');
    expect(body.error).not.toContain('ath-1');
  });

  test('a clip whose every athlete consents is released inside the one transaction that asked them all', async () => {
    taggedClip();

    const res = await call();

    expect(res.status).toBe(200);
    expect(writeUnderPlaybackConsent).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledTimes(2);
    // The UPDATE went through the transaction's client -- the one still
    // holding BOTH children's guardian links -- so a withdrawal by the
    // partner's guardian either lands first and is read, or waits.
    expect(TX_CLIENT.query).toHaveBeenCalledTimes(1);
    expect(String(TX_CLIENT.query.mock.calls[0][0])).toContain("set status = 'ready'");
    expect(mockAudit).toHaveBeenCalledTimes(1);
    // The tags of THIS clip, in this organization: two swapped strings would
    // read nothing and silently ask only the clip's own athlete again.
    expect(mockTags).toHaveBeenCalledWith('org-1', 'vid-1');
  });

  test('a tag read that fails is a failure, not an untagged clip: nothing is written', async () => {
    // "We could not find out who is in the clip, so ask only the one it is
    // filed under" is the fail-open direction a consent read must never take.
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockTags.mockRejectedValueOnce(new Error('connection reset'));

    const res = await call();

    expect(res.status).toBe(500);
    expect(writeUnderPlaybackConsent).not.toHaveBeenCalled();
    expect(mockConsent).not.toHaveBeenCalled();
    expect(TX_CLIENT.query).not.toHaveBeenCalled();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the tagged child is refused from inside the write call, after the own athlete cleared, and the write never runs', async () => {
    // What this proves at unit level: the partner's refusal is raised by the
    // helper call that owns the write, so the write cannot run on a consent
    // the partner no longer gives. What it cannot prove: a withdrawal that
    // lands between the check and the UPDATE on a real database -- that is
    // the helper's FOR SHARE, proven for a two-athlete clip in
    // playbackConsentRace.pg.test.ts ('a tagged clip: a withdrawal in flight
    // for the SECOND athlete ...'); the test above proves the UPDATE took
    // that helper's client. The check order here is the double's, not the
    // helper's, which sorts its subjects.
    taggedClip({}, { written: false });
    const order: string[] = [];
    mockConsent.mockImplementation(async (_org: string, athleteId: string) => {
      order.push(`consent:${athleteId}`);
      if (athleteId === 'ath-tagged') throw new ConflictError('Blocked: withdrawn', 'GUARDIAN_CONSENT_WITHDRAWN');
    });

    expect((await call()).status).toBe(409);
    expect(order).toEqual(['consent:ath-1', 'consent:ath-tagged']);
    expect(TX_CLIENT.query).not.toHaveBeenCalled();
  });

  test('a tag naming a deleted athlete reads as not found, as on playback, and asks nobody', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockTags.mockResolvedValueOnce([
      { athlete_id: 'ath-tagged', athlete_deleted: false },
      { athlete_id: 'ath-gone', athlete_deleted: true },
    ]);

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockPrereq).not.toHaveBeenCalled();
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a tag naming the clip\'s own athlete is asked once', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });
    mockTags.mockResolvedValueOnce([
      { athlete_id: 'ath-1', athlete_deleted: false },
      { athlete_id: 'ath-tagged', athlete_deleted: false },
    ]);

    expect((await call()).status).toBe(200);
    expect(writeUnderPlaybackConsent).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-tagged'], expect.any(Function));
  });

  test('an unattributed clip with tags asks the tagged children and writes under their consent', async () => {
    taggedClip({ athlete_id: null });

    expect((await call()).status).toBe(200);
    expect(writeUnderPlaybackConsent).toHaveBeenCalledWith('org-1', ['ath-tagged'], expect.any(Function));
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-tagged');
    expect(TX_CLIENT.query).toHaveBeenCalledTimes(1);
  });

  test('tags are read only after the entitlement refusals, so a tag\'s not-found never confirms a video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-2' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ uploaded_by_account_id: 'coach-1' }));

    expect((await call()).status).toBe(404);
    expect(mockTags).not.toHaveBeenCalled();
  });
});

// The scan sweep and this route share one rule: a person resolves what the scan
// could not, and never overturns what it refused.
describe('the scan verdict outranks the coach', () => {
  test.each([
    ['blocked', 'content screen refused'],
    ['pending', 'waiting on its content scan'],
    ['scanning', 'waiting on its content scan'],
  ])('a %s video cannot be released by hand', async (scanState, expectedMessage) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow({ scan_state: scanState }));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(expectedMessage);
    // One read, no write: the update must never have been attempted.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an environment with no scan gate still allows a human release', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow({ scan_state: 'unconfigured' }))
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('under coach_attested the uploading coach may release a pending video', async () => {
    // The organization's decision, not a constant: a club whose coaches are
    // all screened, reviewing its own footage the evening it was filmed.
    jest.mocked(getVideoReleasePolicy).mockResolvedValueOnce('coach_attested');
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow({ scan_state: 'pending' }))
      .mockResolvedValueOnce({ status: 'ready' });

    const res = await call();

    expect(res.status).toBe(200);
    // The audit row records which posture allowed it, so a release under the
    // loosened policy is distinguishable afterwards from a deferred verdict.
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          release_policy: 'coach_attested',
          from_scan_state: 'pending',
        }),
      }),
    );
  });

  test.each(['blocked', 'infected'])(
    'coach_attested still cannot release a %s video -- the ceiling is not a dial',
    async (scanState) => {
      jest.mocked(getVideoReleasePolicy).mockResolvedValueOnce('coach_attested');
      mockRequirePrincipal.mockResolvedValueOnce(principal({}));
      mockQueryOne.mockResolvedValueOnce(videoRow({
        status: scanState === 'infected' ? 'infected' : 'quarantined',
        scan_state: scanState,
      }));

      const res = await call();

      expect(res.status).toBe(409);
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test('the write repeats the scan-state predicate, not just the status', async () => {
    /*
     * NARROWED FROM `any(releasable)` TO THE EXACT REVIEWED STATE, and the
     * original intent of this test survives the change: the write is still
     * guarded on scan_state and not on status alone.
     *
     * It is now guarded harder. `any(releasable)` accepted ANY state a person
     * could clear, so a re-scan between the read and the write could swap one
     * releasable verdict for another and the release would still land -- on a
     * review of a verdict the actor never saw.
     */
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    await call();

    const [sql, params] = mockQueryOne.mock.calls[1];
    expect(String(sql)).toContain('scan_state = $3');
    expect(params[2]).toBe('needs_human_review');
  });

  test('a blocked video is still refused before any write is attempted', async () => {
    /*
     * The property the old `any(releasable)` predicate also carried: a
     * content-screen refusal is not releasable here. It now lives entirely in
     * the state check above the write, so this asserts the refusal AND that
     * no UPDATE was reached -- which the SQL predicate alone never proved.
     */
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(videoRow({ scan_state: 'blocked' }));

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });
});
