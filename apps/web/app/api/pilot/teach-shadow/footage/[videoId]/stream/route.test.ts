import type { NextRequest } from 'next/server';

import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import {
  VideoNotClippableError,
  assertVideoClippable,
} from '@/src/server/pilot/calibration/projects';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';

import { GET } from './route';

/**
 * Teaching footage's own playback door.
 *
 * It exists because two correct rules contradicted each other: only take-backed
 * footage may be cut into a clip, and the Film Study route refuses take-backed
 * footage. See teachingFootagePlayableContract.test.ts for the full account.
 *
 * What this suite pins is that the door is narrow: the same gate the cut asks,
 * a flat 404 on every refusal, and a response that cannot be cached.
 */

jest.mock('@/src/server/pilot/calibration/projects', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/projects');
  return { ...actual, assertVideoClippable: jest.fn() };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/blob', () => ({
  getPilotVideoSasUrl: jest.fn(() => 'https://blob.example/take.webm?sas'),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockSas = getPilotVideoSasUrl as jest.Mock;

const COACH = {
  accountId: 'coach-1',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'token',
  authProvider: 'ppbf_local',
};

function call(videoId = 'vid-teaching') {
  const request = new Request(
    `http://localhost/api/pilot/teach-shadow/footage/${videoId}/stream`,
  ) as NextRequest;
  return GET(request, { params: Promise.resolve({ videoId }) });
}

beforeEach(() => { jest.clearAllMocks(); });

test('401 when unauthenticated, and nothing is read on the way out', async () => {
  mockPrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

  expect((await call()).status).toBe(401);
  expect(mockClippable).not.toHaveBeenCalled();
  expect(mockSas).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
  'a %s is refused before any gate is consulted',
  async (role) => {
    // The same annotator gate the rest of this area holds. platform_owner is
    // in this list on purpose: ANNOTATOR_ROLES excludes it, so the platform
    // admin cannot reach Teach Shadow work at all.
    mockPrincipal.mockResolvedValueOnce({ ...COACH, role });

    expect((await call()).status).toBe(403);
    expect(mockClippable).not.toHaveBeenCalled();
  },
);

test('a coach gets a stream for footage the study gate accepts', async () => {
  mockPrincipal.mockResolvedValueOnce(COACH);
  mockClippable.mockResolvedValueOnce({ videoSessionId: 'vid-teaching', athleteId: null });
  mockQueryOne.mockResolvedValueOnce({ blob_path: 'org-1/vid/take.webm', file_name: 'take.webm' });

  const response = await call();
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ ok: true, video_session_id: 'vid-teaching', file_name: 'take.webm' });
  expect(body.stream_url).toBe('https://blob.example/take.webm?sas');
  expect(mockClippable).toHaveBeenCalledWith('org-1', 'vid-teaching');
});

test('the response carrying a bearer credential must not be stored', async () => {
  /*
   * A SAS URL is not a reference, it is a credential: whoever holds the string
   * can fetch the footage for the whole window, with no session and no record
   * of who held it. A cached copy hands it to a second holder nobody recorded.
   */
  mockPrincipal.mockResolvedValueOnce(COACH);
  mockClippable.mockResolvedValueOnce({ videoSessionId: 'vid-teaching', athleteId: null });
  mockQueryOne.mockResolvedValueOnce({ blob_path: 'p', file_name: 'f.webm' });

  const response = await call();

  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
});

test.each([
  ['archived footage', new VideoNotClippableError('archived')],
  ['held footage', new VideoNotClippableError('quarantined')],
  ['a video that is not here', new VideoNotClippableError(null)],
  ['Film Study media', new VideoNotClippableError('ready', 'not_teaching_footage')],
])('%s is refused as a flat 404, with no reason disclosed', async (_label, refusal) => {
  /*
   * VideoNotClippableError names the status it found -- useful to an operator,
   * and more than this route should tell a caller who may not be entitled to
   * know the video exists. Every refusal is answered identically, the way the
   * Film Study route answers its own.
   */
  mockPrincipal.mockResolvedValueOnce(COACH);
  mockClippable.mockRejectedValueOnce(refusal);

  const response = await call();
  const body = await response.json();

  expect(response.status).toBe(404);
  expect(JSON.stringify(body)).not.toMatch(/archived|quarantined|teach Shadow/i);
  expect(mockSas).not.toHaveBeenCalled();
});

test('a row that disappears between the gate and the read is refused, not assumed', async () => {
  mockPrincipal.mockResolvedValueOnce(COACH);
  mockClippable.mockResolvedValueOnce({ videoSessionId: 'vid-teaching', athleteId: null });
  mockQueryOne.mockResolvedValueOnce(null);

  expect((await call()).status).toBe(404);
  expect(mockSas).not.toHaveBeenCalled();
});

test('the read is organization-scoped from the session, never from the caller', async () => {
  mockPrincipal.mockResolvedValueOnce(COACH);
  mockClippable.mockResolvedValueOnce({ videoSessionId: 'vid-teaching', athleteId: null });
  mockQueryOne.mockResolvedValueOnce({ blob_path: 'p', file_name: 'f.webm' });

  await call();

  const [sql, params] = mockQueryOne.mock.calls[0]!;
  expect(String(sql)).toContain('organization_id = $1');
  expect(params[0]).toBe('org-1');
});

test('no athlete name crosses this route', async () => {
  // Teaching media names nobody (TS-ANON-01). The row read here selects only
  // the blob path and the file name; a surface that read a column it must
  // never show is one refactor away from showing it.
  mockPrincipal.mockResolvedValueOnce(COACH);
  mockClippable.mockResolvedValueOnce({ videoSessionId: 'vid-teaching', athleteId: null });
  mockQueryOne.mockResolvedValueOnce({ blob_path: 'p', file_name: 'f.webm' });

  const raw = JSON.stringify(await (await call()).json());

  expect(raw).not.toContain('athlete');
  const [sql] = mockQueryOne.mock.calls[0]!;
  expect(String(sql)).not.toContain('athlete_id');
});
