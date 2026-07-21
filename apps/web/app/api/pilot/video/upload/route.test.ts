import { NextRequest } from 'next/server';

import { POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
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
  uploadPilotVideoFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/shadowEvents', () => ({
  emitShadowEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/shadowTelemetry', () => ({
  writeShadowTelemetryEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

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

function uploadRequest(fields: Record<string, string | Blob>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest('http://localhost/api/pilot/video/upload', { method: 'POST', body: formData });
}

const videoFile = () => new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' });

describe('POST /api/pilot/video/upload', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot upload', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete' }));
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(403);
  });

  test('400 when file is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await POST(uploadRequest({ title: 'no file here' }));
    expect(res.status).toBe(400);
  });

  test('415 for unsupported mime type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const badFile = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });
    const res = await POST(uploadRequest({ file: badFile }));
    expect(res.status).toBe(415);
  });

  test('403 when coach uploads for an unassigned athlete (coach-assignment enforcement)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('201 when coach uploads for an assigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-1' }));
    expect(res.status).toBe(201);
  });

  test('201 when coach uploads an unattributed (team) video with no athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([]);
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(201);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('403 when organization_admin uploads for an athlete outside their organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-other-org' }));
    expect(res.status).toBe(403);
  });
});
