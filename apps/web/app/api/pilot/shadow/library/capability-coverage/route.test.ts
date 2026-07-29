import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  listShadowCapabilityCoverage,
  recomputeShadowCapabilityCoverage,
  upsertShadowCapabilityMap,
} from '@/src/server/pilot/shadowLibrary';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  listShadowCapabilityCoverage: jest.fn(),
  recomputeShadowCapabilityCoverage: jest.fn(),
  upsertShadowCapabilityMap: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockList = listShadowCapabilityCoverage as jest.MockedFunction<typeof listShadowCapabilityCoverage>;
const mockRecompute = recomputeShadowCapabilityCoverage as jest.MockedFunction<typeof recomputeShadowCapabilityCoverage>;
const mockUpsert = upsertShadowCapabilityMap as jest.MockedFunction<typeof upsertShadowCapabilityMap>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/capability-coverage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest() {
  return new NextRequest('http://localhost/api/pilot/shadow/library/capability-coverage', { method: 'GET' });
}

const validRule = {
  capability_key: 'shadow.doctrine.authority-boundary',
  required_source_types: ['internal_policy'],
  minimum_authority_tier: 1,
  minimum_source_count: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue(undefined);
  mockRecompute.mockResolvedValue([]);
  mockList.mockResolvedValue([]);
});

describe('POST /api/pilot/shadow/library/capability-coverage', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await POST(postRequest(validRule));

    expect(response.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent'] as const)('refuses %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(postRequest(validRule));

    expect(response.status).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('upserts a rule against the session organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validRule, organization_id: 'org-attacker' }));

    expect(response.status).toBe(201);
    expect(mockUpsert).toHaveBeenCalledWith({
      organizationId: 'org-real',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      capabilityKey: 'shadow.doctrine.authority-boundary',
      requiredSourceTypes: ['internal_policy'],
      minimumAuthorityTier: 1,
      minimumSourceCount: 1,
    });
  });

  describe('recompute', () => {
    test('regrades instead of upserting when action is recompute', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ action: 'recompute' }));

      expect(response.status).toBe(200);
      expect(mockRecompute).toHaveBeenCalledTimes(1);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    test('returns items under the key the seed script reads', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockRecompute.mockResolvedValueOnce([{ capability_key: 'a' }, { capability_key: 'b' }] as never);

      const response = await POST(postRequest({ action: 'recompute' }));
      const payload = await response.json();

      // The seed script reports `coverage.items.length` as its rule count.
      expect(payload.items).toHaveLength(2);
    });

    test('does not require a capability_key', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ action: 'recompute' }));

      // The seed script posts recompute with no other field. Requiring
      // capability_key first would 400 the final step of every seed run.
      expect(response.status).toBe(200);
    });
  });

  test('rejects an unknown action rather than treating it as a rule upsert', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ action: 'delete_all', ...validRule }));

    expect(response.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  test.each([
    ['a missing capability_key', { capability_key: '  ' }],
    ['a non-array required_source_types', { required_source_types: 'internal_policy' }],
    ['a required_source_types entry that is not a string', { required_source_types: [7] }],
    ['an out-of-range minimum_authority_tier', { minimum_authority_tier: 9 }],
    ['a zero minimum_source_count', { minimum_source_count: 0 }],
    ['a minimum_source_count above the cap', { minimum_source_count: 101 }],
  ])('rejects %s', async (_label, override) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validRule, ...override }));

    expect(response.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/pilot/shadow/library/capability-coverage', () => {
  test('lists coverage for the session organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockList.mockResolvedValueOnce([{ capability_key: 'a' }] as never);

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(mockList).toHaveBeenCalledWith('org-real');
    expect(payload.items).toHaveLength(1);
  });

  test.each(['coach', 'athlete'] as const)('refuses %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});
