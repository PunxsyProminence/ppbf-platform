import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  advanceTake,
  closeRecordingSession,
  createRecordingSession,
  findOpenSessionByJoinCode,
  getOpenTake,
  getSessionById,
  listTakeFiles,
} from '@/src/server/pilot/captureSessions';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/captureSessions', () => {
  const actual = jest.requireActual('@/src/server/pilot/captureSessions');
  return {
    ...actual,
    createRecordingSession: jest.fn(),
    findOpenSessionByJoinCode: jest.fn(),
    getSessionById: jest.fn(),
    getOpenTake: jest.fn(),
    advanceTake: jest.fn(),
    closeRecordingSession: jest.fn(),
    listTakeFiles: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCreate = jest.mocked(createRecordingSession);
const mockFindByCode = jest.mocked(findOpenSessionByJoinCode);
const mockGetSession = jest.mocked(getSessionById);
const mockGetOpenTake = jest.mocked(getOpenTake);
const mockAdvance = jest.mocked(advanceTake);
const mockClose = jest.mocked(closeRecordingSession);
const mockListFiles = jest.mocked(listTakeFiles);

const SESSION = {
  recordingSessionId: 'rs-1',
  organizationId: 'org-a',
  createdByAccountId: 'acct-coach',
  trainingContext: 'heavy_bag' as const,
  joinCode: 'H7K2QP',
  state: 'open' as const,
  createdAt: '2026-09-23T10:00:00Z',
};

const TAKE = {
  captureTakeId: 'take-1',
  recordingSessionId: 'rs-1',
  takeNumber: 1,
  state: 'open' as const,
  createdAt: '2026-09-23T10:00:00Z',
};

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return { accountId: 'acct-coach', role, organizationId: 'org-a', athleteId: null, ...overrides } as never;
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/video/capture-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(qs = ''): NextRequest {
  return new NextRequest(`https://ppbf.example/api/pilot/video/capture-session${qs}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ session: SESSION, take: TAKE });
  mockFindByCode.mockResolvedValue(SESSION);
  mockGetSession.mockResolvedValue(SESSION);
  mockGetOpenTake.mockResolvedValue(TAKE);
  mockAdvance.mockResolvedValue({ ...TAKE, captureTakeId: 'take-2', takeNumber: 2 });
  mockClose.mockResolvedValue(undefined);
  mockListFiles.mockResolvedValue([]);
});

describe('who may reach the recording session', () => {
  /*
   * THE SAME ROLES AS UPLOAD, deliberately. Files produced here go through
   * /api/pilot/video/upload, which admits organization_admin and coach. A
   * narrower gate would let someone start a session and then be refused the
   * upload of the footage they just shot.
   */
  test('a coach and an organization admin may both start a session', async () => {
    for (const role of ['coach', 'organization_admin']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await POST(jsonRequest({ action: 'create', training_context: 'heavy_bag' }));
      expect(response.status).toBe(200);
    }
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('everyone else is refused and no session is created', async () => {
    for (const role of ['athlete', 'parent', 'board', 'platform_owner']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await POST(jsonRequest({ action: 'create', training_context: 'heavy_bag' }));
      expect(response.status).toBe(403);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('the same gate applies to reading a session, not only to writing one', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete'));
    const response = await GET(getRequest('?recording_session_id=rs-1'));
    expect(response.status).toBe(403);
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

describe('the join code is correlation, not authorization', () => {
  /*
   * This is the property the whole design rests on. A code says WHICH session
   * a device means. It never says the device MAY join: the lookup is scoped to
   * the caller's own organization, so a code read aloud in one gym cannot
   * reach another gym's session even if the characters match.
   */
  test('a code is only ever matched within the caller own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { organizationId: 'org-b' }));

    await POST(jsonRequest({ action: 'join', join_code: 'H7K2QP' }));

    expect(mockFindByCode).toHaveBeenCalledWith('org-b', 'H7K2QP');
  });

  test('a code that matches no open session in this organization is a 404', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockFindByCode.mockResolvedValueOnce(null);

    const response = await POST(jsonRequest({ action: 'join', join_code: 'NOPE12' }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  test('joining returns the current take, so the device knows what to record against', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ action: 'join', join_code: 'H7K2QP' }));

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        session: expect.objectContaining({
          recording_session_id: 'rs-1',
          current_take: expect.objectContaining({ capture_take_id: 'take-1', take_number: 1 }),
        }),
      }),
    );
  });
});

describe('validation', () => {
  test.each([
    ['no action', {}],
    ['an unsupported action', { action: 'delete' }],
    ['a create with no training context', { action: 'create' }],
    ['a create with an invented training context', { action: 'create', training_context: 'juggling' }],
    ['a join with no code', { action: 'join', join_code: '   ' }],
    ['advancing with no session id', { action: 'advance_take' }],
  ])('%s is a 400 and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest(body));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});

describe('takes advance without rejoining', () => {
  /*
   * Coaches do not re-enter the code between punches. Devices join the
   * SESSION; takes advance inside it. Making them rejoin per jab would make
   * the code a per-rep ceremony and nobody would use the tool.
   */
  test('the next take is opened against the existing session', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ action: 'advance_take', recording_session_id: 'rs-1' }));

    expect(response.status).toBe(200);
    expect(mockAdvance).toHaveBeenCalledWith({ organizationId: 'org-a', recordingSessionId: 'rs-1' });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          current_take: expect.objectContaining({ take_number: 2 }),
        }),
      }),
    );
  });

  test('a session belonging to another organization is not found, not forbidden', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockGetSession.mockResolvedValueOnce(null);

    const response = await POST(jsonRequest({ action: 'advance_take', recording_session_id: 'rs-elsewhere' }));

    expect(response.status).toBe(404);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  test('closing a session is scoped to the caller organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ action: 'close', recording_session_id: 'rs-1' }));

    expect(response.status).toBe(200);
    expect(mockClose).toHaveBeenCalledWith({ organizationId: 'org-a', recordingSessionId: 'rs-1' });
  });
});

describe('reading the session state', () => {
  test('lists the angles recorded against the current take', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockListFiles.mockResolvedValueOnce([
      {
        videoSessionId: 'vs-1',
        cameraViewId: 'view-1',
        cameraView: 'front',
        uploadedByAccountId: 'acct-coach',
        status: 'quarantined',
        recordedAt: null,
        createdAt: '2026-09-23T10:02:00Z',
      },
    ]);

    const response = await GET(getRequest('?recording_session_id=rs-1'));

    expect(response.status).toBe(200);
    expect(mockListFiles).toHaveBeenCalledWith('org-a', 'take-1');
    const payload = (await response.json()) as { session: { current_take: { files: unknown[] } } };
    expect(payload.session.current_take.files).toHaveLength(1);
  });

  test('a missing recording_session_id is a 400, not an unbounded read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
