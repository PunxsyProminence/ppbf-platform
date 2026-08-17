import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getVideoReleasePolicy } from '@/src/server/pilot/videoReleasePolicy';
import { queryOne } from '@/src/server/pilot/db';
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
jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ status: 'ready' });

    await call();

    const [sql, params] = mockQueryOne.mock.calls[1];
    expect(sql).toContain('scan_state = any(');
    expect(params[2]).toEqual(expect.arrayContaining(['needs_human_review', 'unconfigured']));
    expect(params[2]).not.toContain('blocked');
  });
});
