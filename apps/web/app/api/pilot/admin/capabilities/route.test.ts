import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  queryOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requirePrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

function principal(role: string, organizationId = 'org-owner') {
  return { accountId: `${role}@punxsyprominence.org`, role, organizationId, athleteId: null };
}

function getRequest(search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/admin/capabilities${search}`, { method: 'GET' });
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/capabilities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('/api/pilot/admin/capabilities', () => {
  test('reads the platform owner session organization when no override is supplied', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
    mockQueryOne.mockResolvedValueOnce({ capabilities: [{ capabilityId: 'CAP-001' }] });

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-owner']);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      capabilities: [{ capabilityId: 'CAP-001' }],
    });
  });

  test('reads the organization a platform owner names explicitly', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(getRequest('?organization_id=org-gym-2'));

    expect(response.status).toBe(200);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-gym-2']);
  });

  test('saves the platform owner edit instead of refusing it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ capabilities: [{ capabilityId: 'CAP-002' }] }));

    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([
      'org-owner',
      JSON.stringify([{ capabilityId: 'CAP-002' }]),
      'platform_owner@punxsyprominence.org',
    ]);
  });

  test('writes to the organization a platform owner names explicitly', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ capabilities: [], organization_id: 'org-gym-2' }));

    expect(response.status).toBe(200);
    expect(mockQuery.mock.calls[0][1][0]).toBe('org-gym-2');
  });

  test('ignores an organization override from an organization admin', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', 'org-gym-1'));

    const response = await POST(postRequest({ capabilities: [], organization_id: 'org-gym-2' }));

    expect(response.status).toBe(200);
    expect(mockQuery.mock.calls[0][1][0]).toBe('org-gym-1');
  });

  test('refuses a role that does not administer capabilities', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', 'org-gym-1'));

    const response = await POST(postRequest({ capabilities: [] }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
