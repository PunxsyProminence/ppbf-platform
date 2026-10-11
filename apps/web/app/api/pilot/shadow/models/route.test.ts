import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);

function principal(
  role: PilotPrincipal['role'],
  accountId = 'account-1',
  organizationId = 'org-1',
): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId,
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

  // OD-2026-10-10-004 ruling 3 removes the platform owner from routes that
  // reach gym data, "keeping anything that is truly platform-level". This route
  // is kept: what it returns is the deployment's model list. The three tests
  // below are the proof that no gym data is behind it.
  test('the platform owner still reads the model list', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; models: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(Object.keys(payload.models).length).toBeGreaterThan(0);
  });

  test('the answer is the same for every caller and every gym, and names neither', async () => {
    const read = async (who: PilotPrincipal) => {
      mockRequirePrincipal.mockResolvedValueOnce(who);
      const response = await GET(getRequest());
      expect(response.status).toBe(200);
      return response.text();
    };

    const asOwner = await read(principal('platform_owner', 'acct-OWNER-7c1', 'gym-ALPHA-93f'));
    const asCoach = await read(principal('coach', 'acct-COACH-2b8', 'gym-BRAVO-51d'));
    const asGymAdmin = await read(principal('organization_admin', 'acct-ADMIN-e40', 'gym-CHARLIE-a66'));

    expect(asOwner).toBe(asCoach);
    expect(asOwner).toBe(asGymAdmin);
    for (const marker of ['acct-OWNER-7c1', 'gym-ALPHA-93f', 'acct-COACH-2b8', 'gym-BRAVO-51d']) {
      expect(asOwner).not.toContain(marker);
    }
  });

  test('the answer is only model fields, built without a database read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(getRequest());
    const payload = await response.json() as Record<string, unknown> & {
      models: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(payload).sort()).toEqual(['models', 'ok']);
    for (const model of Object.values(payload.models)) {
      expect(Object.keys(model).sort()).toEqual(['available', 'displayName', 'tier']);
      expect(typeof model.displayName).toBe('string');
      expect(typeof model.available).toBe('boolean');
      expect(typeof model.tier).toBe('string');
    }
    expect(query).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
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
