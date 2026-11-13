import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getClassPlanTrack, listClassPlanTracks } from '@/src/server/pilot/classPlans';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

// Class plans API (OD-2026-11-12-005 ruling 2): coaches and gym admins only,
// the organization's own tracks only, and a missing or withdrawn template
// reaches the caller as such. The real jsonError stays in play so the status
// mapping is exercised.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/classPlans', () => ({
  listClassPlanTracks: jest.fn(),
  getClassPlanTrack: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listClassPlanTracks as jest.Mock;
const mockTrack = getClassPlanTrack as jest.Mock;

afterEach(() => jest.clearAllMocks());

function principal(role: PilotRole, organizationId = 'org-1'): PilotPrincipal {
  return { accountId: 'acct-1', role, organizationId, athleteId: null, sessionToken: 't', authProvider: 'microsoft' } as PilotPrincipal;
}
const request = (query = '') => new NextRequest(`http://localhost/api/pilot/training-tracks${query ? `?${query}` : ''}`);

describe('GET /api/pilot/training-tracks: who may read', () => {
  it.each(['coach', 'organization_admin', 'admin'] as PilotRole[])('admits %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);
    expect((await GET(request())).status).toBe(200);
  });

  it.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'] as PilotRole[])(
    'refuses %s before reading anything, whatever the query says',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal(role));
      expect((await GET(request())).status).toBe(403);
      expect((await GET(request('track=trk_x'))).status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
      expect(mockTrack).not.toHaveBeenCalled();
    },
  );
});

describe('GET /api/pilot/training-tracks: what it returns', () => {
  it('lists under `tracks` for the organization of the principal only', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'org-7'));
    mockList.mockResolvedValue([{ track_id: 'trk_1', name: 'Plan' }]);
    const response = await GET(request('organization_id=other-org'));
    expect(await response.json()).toEqual({ tracks: [{ track_id: 'trk_1', name: 'Plan' }] });
    expect(mockList).toHaveBeenCalledWith('org-7');
  });

  it('returns one track under `track`, scoped to the organization of the principal, and 404s an unknown one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('admin', 'org-7'));
    mockTrack.mockResolvedValueOnce({ track_id: 'trk_1', weeks: [] });
    expect(await (await GET(request('track=trk_1'))).json()).toEqual({ track: { track_id: 'trk_1', weeks: [] } });
    expect(mockTrack).toHaveBeenCalledWith('org-7', 'trk_1');
    mockTrack.mockResolvedValueOnce(null);
    const missing = await GET(request('track=trk_other_gym'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'TRAINING_TRACK_NOT_FOUND' });
  });

  it('passes a missing and a withdrawn template through as such, not dropped', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    const days = [
      { template: { state: 'missing', template_id: null, name: null } },
      { template: { state: 'withdrawn', template_id: 'wt', name: 'Old' } },
    ];
    mockTrack.mockResolvedValue({ track_id: 'trk_1', weeks: [{ days }] });
    const body = await (await GET(request('track=trk_1'))).json();
    expect(body.track.weeks[0].days).toEqual(days);
  });
});
