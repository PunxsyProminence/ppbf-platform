import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { listOrganizationFeedback, listPlatformFeedback } from '@/src/server/pilot/feedback';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/feedback', () => ({
  ...jest.requireActual('@/src/server/pilot/feedback'),
  listOrganizationFeedback: jest.fn(),
  listPlatformFeedback: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockListOrganization = listOrganizationFeedback as jest.MockedFunction<typeof listOrganizationFeedback>;
const mockListPlatform = listPlatformFeedback as jest.MockedFunction<typeof listPlatformFeedback>;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/pilot/feedback/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListOrganization.mockResolvedValue([]);
  mockListPlatform.mockResolvedValue([]);
});

describe('POST /api/pilot/feedback/list', () => {
  test('rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request());

    expect(res.status).toBe(401);
  });

  // Everyone below is a person whose own submissions are in this queue
  // alongside other people's -- including children writing about being hurt.
  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'refuses a %s',
    async (role) => {
      mockResolvePrincipal.mockResolvedValueOnce(principal({ role, accountId: `acct-${role}` }));

      const res = await POST(request());

      expect(res.status).toBe(403);
      expect(mockListOrganization).not.toHaveBeenCalled();
      expect(mockListPlatform).not.toHaveBeenCalled();
    },
  );

  test('refuses a PIN session even when it holds an admin role', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local' }));

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(mockListOrganization).not.toHaveBeenCalled();
  });

  test('a gym admin reads their own gym, named, and cannot ask for another', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ organization_id: 'org-2', limit: 10 }));
    const payload = (await res.json()) as { scope: string; organization_id: string };

    expect(res.status).toBe(200);
    expect(payload.scope).toBe('organization');
    expect(payload.organization_id).toBe('org-1');
    expect(mockListOrganization).toHaveBeenCalledWith('org-1', {
      route: null,
      triageStatus: null,
      limit: 10,
    });
    expect(mockListPlatform).not.toHaveBeenCalled();
  });

  test('the legacy admin role reads the same gym-scoped queue', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'admin' }));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mockListOrganization).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  // The de-identification is a property of the platform statement, so the only
  // thing this route has to get right is never sending the owner down the
  // named path.
  test('the platform owner reads every gym and never the named query', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(
      principal({ role: 'platform_owner', accountId: 'acct-omega' }),
    );

    const res = await POST(request({ route: 'safeguarding' }));
    const payload = (await res.json()) as { scope: string; organization_id?: string };

    expect(res.status).toBe(200);
    expect(payload.scope).toBe('platform');
    expect(payload).not.toHaveProperty('organization_id');
    expect(mockListPlatform).toHaveBeenCalledWith({
      route: 'safeguarding',
      triageStatus: null,
      limit: undefined,
    });
    expect(mockListOrganization).not.toHaveBeenCalled();
  });

  test('refuses a route or status outside the stored vocabulary', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    expect((await POST(request({ route: 'backlog' }))).status).toBe(400);

    mockResolvePrincipal.mockResolvedValueOnce(principal());
    expect((await POST(request({ triage_status: 'wontfix' }))).status).toBe(400);

    expect(mockListOrganization).not.toHaveBeenCalled();
    expect(mockListPlatform).not.toHaveBeenCalled();
  });

  test('an omitted filter reads both lanes rather than silently hiding one', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    await POST(request());

    expect(mockListOrganization).toHaveBeenCalledWith('org-1', {
      route: null,
      triageStatus: null,
      limit: undefined,
    });
  });
});
