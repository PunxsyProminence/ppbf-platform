import { NextRequest } from 'next/server';

import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getVideoReleasePolicy } from '@/src/server/pilot/videoReleasePolicy';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

import { GET } from './route';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

// Doubled so this suite exercises the ROUTE, not the policy lookup, which has
// its own database-backed suite. Strict posture by default.
jest.mock('@/src/server/pilot/videoReleasePolicy', () => {
  const actual = jest.requireActual('@/src/server/pilot/videoReleasePolicy');
  return { ...actual, getVideoReleasePolicy: jest.fn(async () => 'scan_required') };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockPolicy = getVideoReleasePolicy as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
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

const request = (url = 'http://localhost/api/pilot/teach-shadow/held') => new NextRequest(url);

const heldRow = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vs-1',
  file_name: 'capture.webm',
  take_number: 3,
  camera_view: 'front',
  recorded_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  status: 'quarantined',
  scan_state: 'needs_human_review',
  ...overrides,
});

test('401 when unauthenticated', async () => {
  mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

  expect((await GET(request())).status).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
  'a %s is refused, and nothing is read on the way to the refusal',
  async (role) => {
    // Held teaching footage is a coaching queue. Nobody outside the release
    // authority has business reading what is waiting.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: role as PilotPrincipal['role'] }));

    expect((await GET(request())).status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  },
);

test('a coach sees only what they uploaded', async () => {
  /*
   * SCOPED TO WHO MAY ACT, NOT WHO MAY LOOK. A coach releases what they
   * filmed; listing a colleague's held angle would be a queue of somebody
   * else's problem, with no button that works.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-7' }));
  mockQuery.mockResolvedValueOnce([]);

  await GET(request());

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).toContain('uploaded_by_account_id');
  expect(params).toContain('coach-7');
});

test('an organization admin sees the whole gym, because they can release any of it', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
  mockQuery.mockResolvedValueOnce([]);

  await GET(request());

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).not.toContain('uploaded_by_account_id');
  expect(params[0]).toBe('org-1');
});

test('only teaching footage is listed, and only while it is still held', async () => {
  // Film Study has its own screen. This queue is the footage that cannot
  // reach the corpus until somebody releases it.
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([]);

  await GET(request());

  const [sql] = mockQuery.mock.calls[0]!;
  expect(String(sql)).toContain('capture_take_id is not null');
  expect(String(sql)).toContain("('quarantined', 'infected')");
});

test('whether a row can be released is decided here, not by the page', async () => {
  /*
   * The page should not be interpreting a scan verdict against an
   * organization's policy. Under the strict posture a row a person could
   * clear by hand is releasable; one the screen refused never is.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([
    heldRow({ video_session_id: 'vs-ok', scan_state: 'needs_human_review' }),
    heldRow({ video_session_id: 'vs-blocked', scan_state: 'blocked' }),
    heldRow({ video_session_id: 'vs-scanning', scan_state: 'scanning' }),
  ]);

  const body = await (await GET(request())).json();

  expect(body.items.map((item: { video_session_id: string; releasable: boolean }) => [item.video_session_id, item.releasable]))
    .toEqual([['vs-ok', true], ['vs-blocked', false], ['vs-scanning', false]]);
  expect(body.items[1].refused_by_scan).toBe(true);
});

test('a looser policy lets more through, and the route reports it rather than deciding it', async () => {
  // coach_attested also allows a coach to clear a scan still in flight.
  mockPolicy.mockResolvedValueOnce('coach_attested');
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([heldRow({ scan_state: 'scanning' })]);

  const body = await (await GET(request())).json();

  expect(body.items[0].releasable).toBe(true);
  expect(body.release_policy).toBe('coach_attested');
});

test('no athlete name crosses this route', async () => {
  /*
   * The rest of the Teach Shadow area holds the same line: a coach finds
   * their own footage by take, angle and time. Nothing here needs to name
   * the person who was filmed.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([heldRow()]);

  const response = await GET(request());
  const raw = JSON.stringify(await response.json());

  expect(raw).not.toContain('athlete');
  const [sql] = mockQuery.mock.calls[0]!;
  expect(String(sql)).not.toContain('athlete_id');
});

test('an invalid limit is refused before anything is read', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await GET(request('http://localhost/api/pilot/teach-shadow/held?limit=0'));

  expect(response.status).toBe(400);
  expect(mockQuery).not.toHaveBeenCalled();
});
