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

// Only the enforcer is mocked; the pure resolver and message helper stay REAL so
// the route applies the same limits it ships with.
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn().mockResolvedValue(undefined) };
});

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
  return new NextRequest('http://localhost/api/pilot/video/upload', {
    method: 'POST',
    body: formData,
    headers: { 'content-length': '4096' },
  });
}

const videoFile = () => new File(
  [new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])],
  'clip.mp4',
  { type: 'video/mp4' },
);

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

  test('415 when the bytes do not match the declared video type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const spoofed = new File(
      [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])],
      'spoofed.mp4',
      { type: 'video/mp4' },
    );
    const res = await POST(uploadRequest({ file: spoofed }));
    expect(res.status).toBe(415);
  });

  test('403 when coach uploads for an unassigned athlete (coach-assignment enforcement)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('202 when coach uploads for an assigned athlete into quarantine', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([]);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(expect.objectContaining({
      status: 'quarantined',
      accepted_for_security_review: true,
    }));
  });

  test('the upload response says whether anything will actually scan the video', async () => {
    // Before #49 nothing in the platform could move a video off 'quarantined',
    // yet this response reported it accepted for security review. The claim
    // has to track the environment.
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([]);
    const withoutScanner = await (await POST(uploadRequest({ file: videoFile() }))).json();
    expect(withoutScanner.scan_pending).toBe(false);
    expect(withoutScanner.message).toMatch(/no video scanner is configured/i);

    process.env.PPBF_VIDEO_CONTENT_SCAN = 'vision';
    try {
      mockRequirePrincipal.mockResolvedValueOnce(principal({}));
      mockQuery.mockResolvedValueOnce([]);
      const withScanner = await (await POST(uploadRequest({ file: videoFile() }))).json();
      expect(withScanner.scan_pending).toBe(true);
      expect(withScanner.message).toMatch(/until an automated scan clears it/i);
    } finally {
      delete process.env.PPBF_VIDEO_CONTENT_SCAN;
    }
  });

  test('202 when coach uploads an unattributed (team) video with no athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockQuery.mockResolvedValueOnce([]);
    const res = await POST(uploadRequest({ file: videoFile() }));
    expect(res.status).toBe(202);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('403 when organization_admin uploads for an athlete outside their organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest({ file: videoFile(), athlete_id: 'ath-other-org' }));
    expect(res.status).toBe(403);
  });
});
