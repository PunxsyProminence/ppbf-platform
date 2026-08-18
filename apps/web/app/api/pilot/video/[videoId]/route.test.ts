import { NextRequest } from 'next/server';

import { GET } from './route';
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

jest.mock('@/src/server/pilot/blob', () => ({
  getPilotVideoSasUrl: jest.fn(() => 'https://blob.example/sas'),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const videoRow = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  organization_id: 'org-1',
  title: 't',
  notes: '',
  file_name: 'f.mp4',
  file_size_bytes: 100,
  mime_type: 'video/mp4',
  status: 'ready',
  athlete_id: 'ath-1',
  blob_path: 'org-1/vid-1/f.mp4',
  uploaded_by_account_id: 'coach-1',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function call(videoId = 'vid-1') {
  const request = new NextRequest(`http://localhost/api/pilot/video/${videoId}`);
  return GET(request, { params: Promise.resolve({ videoId }) });
}

describe('GET /api/pilot/video/[videoId]', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await call();
    expect(res.status).toBe(401);
  });

  test('nonexistent video returns hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await call('does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test.each(['uploaded', 'processing', 'quarantined', 'infected', 'error', 'archived'])(
    'non-ready %s video never receives a playback URL',
    async (status) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQueryOne.mockResolvedValueOnce(videoRow({ status }));
      const res = await call();
      expect(res.status).toBe(404);
      const { getPilotVideoSasUrl } = jest.requireMock('@/src/server/pilot/blob');
      expect(getPilotVideoSasUrl).not.toHaveBeenCalled();
    },
  );

  test('cross-organization video id returns the same hidden not-found response as a nonexistent id', async () => {
    // The row fetch is itself organization-scoped, so a video belonging to
    // another org comes back as null from the DB layer -- identical to a
    // truly nonexistent id.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin', organizationId: 'org-2' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await call('vid-1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('athlete can access their own video', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('athlete accessing another athlete video gets the same hidden not-found response (no 403 oracle)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-2' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: 'ath-1' }));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('parent linked to the video athlete succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('parent not linked gets hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('assigned coach succeeds', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('unassigned coach gets hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('volunteer is denied even though the video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('staff is denied even though the video exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'staff' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('organization_admin can access any video in the org', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertAthleteBelongsToOrganization
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('unattributed video: coach can view it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: null }));
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('unattributed video: athlete cannot view it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow({ athlete_id: null }));
    const res = await call();
    expect(res.status).toBe(404);
  });

  test('the response carrying the playback SAS url is not storable by any cache', async () => {
    // stream_url is a bearer credential: it plays a minor's footage for its
    // whole validity window with no session behind it. A copy retained by the
    // browser or by an intermediary outlives the access check above.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQueryOne.mockResolvedValueOnce(videoRow());
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).stream_url).toBe('https://blob.example/sas');
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
});
