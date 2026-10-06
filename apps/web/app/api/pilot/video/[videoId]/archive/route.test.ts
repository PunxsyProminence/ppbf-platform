import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { setVideoArchiveState } from '@/src/server/pilot/videoArchive';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole and isOrganizationAdminRole stay REAL, so the authority rules
// under test are the shipped ones rather than a doubled approximation.
// Only the athlete-reach check is doubled, because its real form reads the
// assignment tables.
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

// Doubled so this suite exercises the ROUTE. The write itself, including its
// compare-and-set, has a database-backed suite (videoArchive.pg.test.ts) --
// asserting a CAS against a mock would only assert the mock.
jest.mock('@/src/server/pilot/videoArchive', () => ({
  ...jest.requireActual('@/src/server/pilot/videoArchive'),
  setVideoArchiveState: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn().mockResolvedValue(undefined) }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockArchive = setVideoArchiveState as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;

afterEach(() => { jest.clearAllMocks(); });

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

const videoRow = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  status: 'ready',
  // Null on teaching footage by design: TS-ANON-01 -- teaching media names
  // nobody, so a fixture that attached an athlete would describe a state the
  // platform no longer creates.
  athlete_id: null,
  capture_take_id: 'take-1',
  uploaded_by_account_id: 'coach-1',
  file_name: 'take-1.mp4',
  ...overrides,
});

function call(body: unknown = { action: 'archive' }, videoId = 'vid-1') {
  const request = new NextRequest(`http://localhost/api/pilot/video/${videoId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ videoId }) });
}

/*
 * Archiving withdraws footage from the corpus and from playback, so WHO may do
 * it and FROM WHICH STATE are the two properties this route exists to hold.
 * What it must not do is leak existence: the entitlement refusals return the
 * same 404 as a video that is not there.
 */
describe('POST /api/pilot/video/[videoId]/archive', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board'] as const)(
    '%s cannot archive footage',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: 'ath-1' }));
      const res = await call();
      expect(res.status).toBe(403);
      expect(mockQueryOne).not.toHaveBeenCalled();
      expect(mockArchive).not.toHaveBeenCalled();
    },
  );

  test('the uploading coach may archive their own footage', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockArchive.mockResolvedValueOnce({ ...videoRow(), status: 'archived' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'archive', status: 'archived' });
    expect(mockArchive).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      videoSessionId: 'vid-1',
      action: 'archive',
      actorAccountId: 'coach-1',
    }));
  });

  test('a coach cannot archive footage somebody else uploaded, and is not told it exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow({ uploaded_by_account_id: 'coach-2' }));

    const res = await call();

    // hiddenNotFound, not 403: a coach whose list does not include a session
    // must not learn it exists by trying to archive it.
    expect(res.status).toBe(404);
    expect(mockArchive).not.toHaveBeenCalled();
  });

  // CL-A21: uploading footage is not a standing claim on the athlete in it. A
  // coach who has since lost the assignment no longer reaches that athlete,
  // so they may neither restore nor archive the footage -- the same rule
  // videoScanReview.ts applies to reviewing it.
  test.each(['archive', 'restore'] as const)(
    'the uploading coach who no longer reaches the athlete cannot %s, and is not told it exists',
    async (action) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockQueryOne.mockResolvedValueOnce(videoRow({
        athlete_id: 'ath-1',
        capture_take_id: null,
        status: action === 'archive' ? 'ready' : 'archived',
      }));
      mockAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

      const res = await call({ action });

      expect(res.status).toBe(404);
      expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1' }), 'ath-1');
      expect(mockArchive).not.toHaveBeenCalled();
    },
  );

  test('the uploading coach who still reaches the athlete may archive athlete footage', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: 'ath-1', capture_take_id: null }));
    mockArchive.mockResolvedValueOnce({ ...videoRow({ athlete_id: 'ath-1', capture_take_id: null }), status: 'archived' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1' }), 'ath-1');
  });

  test('teaching footage names nobody, so the uploader rule alone applies', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockArchive.mockResolvedValueOnce({ ...videoRow(), status: 'archived' });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  test('an organization admin may archive anyone\'s footage', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ uploaded_by_account_id: 'coach-2' }));
    mockArchive.mockResolvedValueOnce({ ...videoRow(), status: 'archived' });

    expect((await call()).status).toBe(200);
  });

  test('an organization admin is not put through the coach assignment check', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: 'ath-1', capture_take_id: null, uploaded_by_account_id: 'coach-2' }));
    mockArchive.mockResolvedValueOnce({ ...videoRow({ athlete_id: 'ath-1', capture_take_id: null }), status: 'archived' });

    expect((await call()).status).toBe(200);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  test('a video in another organization is not found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    // The read is org-scoped, so a foreign row comes back as no row at all.
    mockQueryOne.mockResolvedValueOnce(null);

    expect((await call()).status).toBe(404);
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test('held footage cannot be archived, and the refusal names the status', async () => {
    /*
     * The pairing that makes restore safe: archive accepts 'ready' only, so
     * 'archived' can only have come from 'ready'. Naming the status here is
     * safe because this runs AFTER the two entitlement refusals, so it reaches
     * nobody who was not already entitled to know the video exists.
     */
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow({ status: 'quarantined' }));

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'quarantined' });
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test('already-archived footage says so rather than archiving twice', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow({ status: 'archived' }));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already archived');
  });

  test('restore is refused on footage that is not archived', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow({ status: 'ready' }));

    const res = await call({ action: 'restore' });

    expect(res.status).toBe(409);
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test('restore returns archived footage to the corpus', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow({ status: 'archived' }));
    mockArchive.mockResolvedValueOnce({ ...videoRow(), status: 'ready' });

    const res = await call({ action: 'restore' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'restore', status: 'ready' });
  });

  test('an unrecognized action is a 400, not a silent archive', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await call({ action: 'delete' });

    // 'delete' is the word somebody reaching for this will type, and it must
    // not fall through to archive -- the two mean different things and only one
    // of them is implemented.
    expect(res.status).toBe(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test('a body with no action archives, which is the only default that is safe', async () => {
    // Archive is reversible; restore promotes. Defaulting to the reversible one
    // means a caller that forgets the field cannot accidentally put footage
    // back into circulation.
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockArchive.mockResolvedValueOnce({ ...videoRow(), status: 'archived' });

    const res = await call({});

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'archive' });
  });

  test('a write that loses its compare-and-set reports a conflict, not success', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockQueryOne.mockResolvedValueOnce(videoRow());
    // The row left 'ready' between the read and the write.
    mockArchive.mockResolvedValueOnce(null);

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'VIDEO_SESSION_CHANGED' });
    // Nothing happened, so nothing is claimed in the audit trail.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the audit row records the transition, the reason, and that this was teaching footage', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    mockArchive.mockResolvedValueOnce({ ...videoRow(), status: 'archived' });

    await call({ action: 'archive', reason: 'test footage of a desk' });

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'video_session',
      entity_id: 'vid-1',
      actor_account_id: 'admin-1',
      details: expect.objectContaining({
        action: 'video_archived',
        prior_status: 'ready',
        resulting_status: 'archived',
        teaching_footage: true,
        reason: 'test footage of a desk',
      }),
    }));
  });
});
