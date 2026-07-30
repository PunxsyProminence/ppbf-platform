import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal } from '@/src/server/pilot/auth';
import { listAnnouncements } from '@/src/server/pilot/announcements';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/announcements', () => ({
  listAnnouncements: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockListAnnouncements = listAnnouncements as jest.MockedFunction<typeof listAnnouncements>;

afterEach(() => {
  jest.clearAllMocks();
});

function request(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/pilot/announcements/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/announcements/get', () => {
  test('rejects an unauthenticated caller without reading any announcements', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request({ organization_id: 'org-2', limit: 5 }));

    expect(res.status).toBe(401);
    expect(mockListAnnouncements).not.toHaveBeenCalled();
  });

  test('ignores a caller-supplied organization_id and scopes to the principal organization', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'athlete-1',
      role: 'athlete',
      organizationId: 'org-1',
      athleteId: 'ath-1',
      sessionToken: 'token-1',
      authProvider: 'ppbf_local',
    });
    mockListAnnouncements.mockResolvedValueOnce([]);

    const res = await POST(request({ organization_id: 'org-2', limit: 5 }));

    expect(res.status).toBe(200);
    expect(mockListAnnouncements).toHaveBeenCalledWith('org-1', 5);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      organization_id: 'org-1',
    });
  });

  test('returns announcements for the principal organization', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'coach-1',
      role: 'coach',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token-1',
      authProvider: 'microsoft',
    });
    mockListAnnouncements.mockResolvedValueOnce([]);

    const res = await POST(request({ limit: 3 }));

    expect(res.status).toBe(200);
    expect(mockListAnnouncements).toHaveBeenCalledWith('org-1', 3);
  });
});
