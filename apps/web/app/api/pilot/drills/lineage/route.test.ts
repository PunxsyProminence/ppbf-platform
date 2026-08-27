import { NextRequest } from 'next/server';

import { GET } from './route';
import { getDrillLineage } from '@/src/server/pilot/drillVersioning';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillVersioning', () => ({ getDrillLineage: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockLineage = getDrillLineage as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/drills/lineage${search}`);
}

beforeEach(() => {
  mockRequirePrincipal.mockResolvedValue(principal());
  mockLineage.mockResolvedValue([{ drill_id: 'drill-1', version: 1 }]);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/drills/lineage', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await GET(getRequest('?lineage_id=lineage-1'));

    expect(res.status).toBe(401);
    expect(mockLineage).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'rejects %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

      const res = await GET(getRequest('?lineage_id=lineage-1'));

      expect(res.status).toBe(403);
      expect(mockLineage).not.toHaveBeenCalled();
    },
  );

  test('requires a lineage_id', async () => {
    const res = await GET(getRequest());

    expect(res.status).toBe(400);
    expect(mockLineage).not.toHaveBeenCalled();
  });

  test('scopes the read to the caller organization', async () => {
    await GET(getRequest('?lineage_id=lineage-1'));

    expect(mockLineage).toHaveBeenCalledWith('org-1', 'lineage-1');
  });

  test('answers with the versions', async () => {
    const res = await GET(getRequest('?lineage_id=lineage-1'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      organization_id: 'org-1',
      lineage_id: 'lineage-1',
      versions: [{ drill_id: 'drill-1', version: 1 }],
    });
  });
});
