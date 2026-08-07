import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { deletePilotProfilePhoto } from '@/src/server/pilot/blob';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  clearPhoto,
  getAccountProfile,
  listPendingReviewPortraits,
  releasePhoto,
} from '@/src/server/pilot/profileDb';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/profileDb', () => ({
  listPendingReviewPortraits: jest.fn(),
  getAccountProfile: jest.fn(),
  releasePhoto: jest.fn(),
  clearPhoto: jest.fn(),
}));

jest.mock('@/src/server/pilot/blob', () => ({
  deletePilotProfilePhoto: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return {
    ...actual,
    requirePrincipal: jest.fn(),
  };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listPendingReviewPortraits);
const mockGetProfile = jest.mocked(getAccountProfile);
const mockRelease = jest.mocked(releasePhoto);
const mockClear = jest.mocked(clearPhoto);
const mockDeleteBlob = jest.mocked(deletePilotProfilePhoto);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function request(url: string): NextRequest {
  return new NextRequest(`https://ppbf.example${url}`);
}

function jsonRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/portrait-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-a',
    accountId: 'acct-athlete',
    nickname: null,
    nicknameClearedAt: null,
    corner: 'none',
    program: 'unstated',
    photoBlobPath: '/blob/path.jpg',
    photoContentType: 'image/jpeg',
    photoReviewState: 'pending_review',
    ...overrides,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/admin/portrait-review', () => {
  test('an organization admin lists the pending-review queue', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockList.mockResolvedValueOnce([
      { accountId: 'acct-1', fullName: 'Sample Athlete', athleteId: 'ath-1', uploadedAt: '2026-08-01T00:00:00Z' },
    ]);

    const response = await GET(request('/api/pilot/admin/portrait-review'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-a');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      portraits: [{ accountId: 'acct-1', fullName: 'Sample Athlete' }],
    });
  });

  test('the legacy admin role name also works', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));
    mockList.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/admin/portrait-review'));

    expect(response.status).toBe(200);
  });

  test('non-admin roles are refused -- this is an org-admin-only console', async () => {
    for (const role of ['athlete', 'parent', 'coach', 'board', 'platform_owner']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/admin/portrait-review'));
      expect(response.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/admin/portrait-review', () => {
  test('approve releases the photo and writes an audit event', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith('org-a', 'acct-athlete', 'acct-admin');
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ok: true, review_state: 'released' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'update',
        entity_type: 'account_profile_photo',
        entity_id: 'acct-athlete',
        details: expect.objectContaining({ action: 'photo_released' }),
      }),
    );
  });

  test('reject deletes the blob and blocks the row, but never the record itself', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile());

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'reject' }));

    expect(response.status).toBe(200);
    expect(mockDeleteBlob).toHaveBeenCalledWith('/blob/path.jpg');
    expect(mockClear).toHaveBeenCalledWith('org-a', 'acct-athlete', 'blocked', 'acct-admin');
    expect(mockRelease).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ok: true, review_state: 'blocked' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ action: 'photo_blocked' }) }),
    );
  });

  test('a coach cannot use the admin console route, even for their own athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(403);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('missing account_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('an unrecognized decision is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'delete' }));

    expect(response.status).toBe(400);
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  test('a subject with no photo on file is a hidden 404, not a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile({ photoBlobPath: null }));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(404);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('a portrait already decided by someone else (race) is refused, not silently re-applied', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetProfile.mockResolvedValueOnce(profile({ photoReviewState: 'released' }));

    const response = await POST(jsonRequest({ account_id: 'acct-athlete', decision: 'approve' }));

    expect(response.status).toBe(400);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
