import { NextRequest } from 'next/server';

import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

import { GET } from './route';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

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

const request = (url = 'http://localhost/api/pilot/teach-shadow/released') => new NextRequest(url);

const releasedRow = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vs-1',
  file_name: 'capture.webm',
  take_number: 3,
  camera_view: 'front',
  recorded_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  status: 'ready',
  scan_state: 'passed',
  clips_cut: 2,
  clips_labelled: 1,
  archive_reason: null,
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
    // The same gate the held queue holds. This is the inventory the corpus is
    // built from and the surface that withdraws footage from it; nobody outside
    // the annotator authority has business reading it.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: role as PilotPrincipal['role'] }));

    expect((await GET(request())).status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  },
);

test('a coach sees only what they uploaded', async () => {
  // Scoped to who may ACT: archive enforces the same rule server-side, so a
  // wider list would be a queue of buttons that return 404.
  mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-7' }));
  mockQuery.mockResolvedValueOnce([]);

  await GET(request());

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).toContain('uploaded_by_account_id');
  expect(params).toContain('coach-7');
});

test('an organization admin sees the whole gym, because they can archive any of it', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
  mockQuery.mockResolvedValueOnce([]);

  await GET(request());

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).not.toContain('uploaded_by_account_id');
  expect(params[0]).toBe('org-1');
});

test('only teaching footage is listed, and only once it is in circulation', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([]);

  await GET(request());

  const [sql] = mockQuery.mock.calls[0]!;
  // The Film Study boundary, the same discriminator the rest of the area uses.
  expect(String(sql)).toContain('capture_take_id is not null');
  // Held footage has its own queue. Archived footage stays listed so the
  // reversible action can actually be reversed.
  expect(String(sql)).toContain("('ready', 'archived')");
});

test('archived rows are marked and carry their reason', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([
    releasedRow({ video_session_id: 'vs-live' }),
    releasedRow({ video_session_id: 'vs-gone', status: 'archived', archive_reason: 'test footage' }),
  ]);

  const body = await (await GET(request())).json();

  expect(body.items.map((item: { video_session_id: string; archived: boolean }) => [item.video_session_id, item.archived]))
    .toEqual([['vs-live', false], ['vs-gone', true]]);
  expect(body.items[1].archive_reason).toBe('test footage');
});

test('a restored row reports no reason, though the jsonb key survives the restore', async () => {
  /*
   * setVideoArchiveState merges with `||`, so the archive key stays on the row
   * after a restore. Reporting its reason on live footage would be a false
   * statement about the current state.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([releasedRow({ status: 'ready', archive_reason: 'a decision since undone' })]);

  const body = await (await GET(request())).json();

  expect(body.items[0]).toMatchObject({ archived: false, archive_reason: null });
});

test('no athlete name crosses this route', async () => {
  /*
   * Teaching media names nobody. athlete_id is NULL on every take-backed row by
   * design and is not read here even so: a surface that selects a column it
   * must never show is one refactor away from showing it.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockQuery.mockResolvedValueOnce([releasedRow()]);

  const response = await GET(request());
  const raw = JSON.stringify(await response.json());

  expect(raw).not.toContain('athlete');
  const [sql] = mockQuery.mock.calls[0]!;
  expect(String(sql)).not.toContain('athlete_id');
});

test('an invalid limit is refused before anything is read', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());

  const response = await GET(request('http://localhost/api/pilot/teach-shadow/released?limit=0'));

  expect(response.status).toBe(400);
  expect(mockQuery).not.toHaveBeenCalled();
});
