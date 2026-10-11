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

// The capability registry is one gym's own list, so this is gym work: the gym's
// admin may, the platform owner may not, on both verbs (OD-2026-10-10-004
// ruling 3). The refusals below are asserted before anything is read or
// written.
describe('/api/pilot/admin/capabilities', () => {
  test.each([
    ['with no organization named', ''],
    ['naming another gym', '?organization_id=org-gym-2'],
    ['naming the gym of its own session', '?organization_id=org-owner'],
  ])('refuses a platform owner read %s, and reads nothing', async (_label, search) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(getRequest(search));

    expect(response.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['with no organization named', { capabilities: [{ capabilityId: 'CAP-002' }] }],
    ['naming another gym', { capabilities: [], organization_id: 'org-gym-2' }],
    ['naming the gym of its own session', { capabilities: [], organization_id: 'org-owner' }],
  ])('refuses a platform owner save %s, and writes nothing', async (_label, body) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest(body));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin'])('%s reads the registry of its own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role, 'org-gym-1'));
    mockQueryOne.mockResolvedValueOnce({ capabilities: [{ capabilityId: 'CAP-001' }] });

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-gym-1']);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      capabilities: [{ capabilityId: 'CAP-001' }],
    });
  });

  test('a gym admin read ignores an organization named in the query', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', 'org-gym-1'));

    const response = await GET(getRequest('?organization_id=org-gym-2'));

    expect(response.status).toBe(200);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-gym-1']);
  });

  test.each(['organization_admin', 'admin'])('%s saves the registry of its own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role, 'org-gym-1'));

    const response = await POST(postRequest({ capabilities: [{ capabilityId: 'CAP-002' }] }));

    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([
      'org-gym-1',
      JSON.stringify([{ capabilityId: 'CAP-002' }]),
      `${role}@punxsyprominence.org`,
    ]);
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
