import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'account-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/models');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/shadow/models', () => {
  test('returns model status for a manual-override-eligible role', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await GET(getRequest());
    const payload = await response.json() as { ok: boolean; models: Record<string, { displayName: string; available: boolean; tier: string }> };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.models['gpt-5-mini-shadow']).toEqual({
      displayName: 'GPT-5 Mini (Quick Round)',
      available: true,
      tier: 'quick',
    });
    expect(payload.models['gpt-5-shadow'].available).toBe(true);
    expect(payload.models['gpt-5-vision-shadow'].available).toBe(true);
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff'] as const)(
    'rejects a role that cannot use manual overrides: %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(getRequest());
      expect(response.status).toBe(403);
    },
  );

  test('rejects an unauthenticated request', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await GET(getRequest());
    expect(response.status).toBe(401);
  });
});
