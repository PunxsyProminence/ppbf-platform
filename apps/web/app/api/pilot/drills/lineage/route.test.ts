import { NextRequest } from 'next/server';

import { GET } from './route';
import { getDrillLineage, getDrillLineageForDrill } from '@/src/server/pilot/drillVersioning';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillVersioning', () => ({
  getDrillLineage: jest.fn(),
  getDrillLineageForDrill: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockLineage = getDrillLineage as jest.Mock;
const mockLineageForDrill = getDrillLineageForDrill as jest.Mock;

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
  mockLineageForDrill.mockResolvedValue([
    { drill_id: 'drill-1', version: 1, lineage_id: 'drill-1' },
    { drill_id: 'drill-2', version: 2, lineage_id: 'drill-1' },
  ]);
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

  describe('by drill_id', () => {
    test.each(['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'] as const)(
      'rejects %s, exactly as by lineage_id',
      async (role) => {
        mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

        const res = await GET(getRequest('?drill_id=drill-2'));

        expect(res.status).toBe(403);
        expect(mockLineageForDrill).not.toHaveBeenCalled();
      },
    );

    test.each(['coach', 'organization_admin', 'admin'] as const)('admits %s', async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

      const res = await GET(getRequest('?drill_id=drill-2'));

      expect(res.status).toBe(200);
    });

    test("resolves the drill's lineage inside the caller's own gym", async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ organizationId: 'org-7' }));

      const res = await GET(getRequest('?drill_id=drill-2'));

      expect(mockLineageForDrill).toHaveBeenCalledWith('org-7', 'drill-2');
      expect(mockLineage).not.toHaveBeenCalled();
      await expect(res.json()).resolves.toEqual({
        ok: true,
        organization_id: 'org-7',
        lineage_id: 'drill-1',
        versions: [
          { drill_id: 'drill-1', version: 1, lineage_id: 'drill-1' },
          { drill_id: 'drill-2', version: 2, lineage_id: 'drill-1' },
        ],
      });
    });

    test("another gym's drill, or no drill, reads empty with a 200", async () => {
      mockLineageForDrill.mockResolvedValueOnce([]);

      const res = await GET(getRequest('?drill_id=other-gym-drill'));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        organization_id: 'org-1',
        lineage_id: null,
        versions: [],
      });
    });

    test('refuses lineage_id and drill_id together', async () => {
      const res = await GET(getRequest('?lineage_id=lineage-1&drill_id=drill-2'));

      expect(res.status).toBe(400);
      expect(mockLineage).not.toHaveBeenCalled();
      expect(mockLineageForDrill).not.toHaveBeenCalled();
    });
  });
});
