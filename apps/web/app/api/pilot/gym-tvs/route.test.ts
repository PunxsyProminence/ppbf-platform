import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { GymTvError, listGymTvs, mintGymTvPairCode } from '@/src/server/pilot/gymTvs';

// requireRole and jsonError stay real; gating and error mapping are the point of this suite.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  listGymTvs: jest.fn(),
  mintGymTvPairCode: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listGymTvs);
const mockMint = jest.mocked(mintGymTvPairCode);

function as(role: string, accountId = 'acct-coach') {
  mockPrincipal.mockResolvedValue({
    accountId,
    organizationId: 'org-1',
    role,
  } as Awaited<ReturnType<typeof requirePrincipal>>);
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/gym-tvs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockMint.mockResolvedValue({ tv_id: 'gymtv_1', tv_name: 'Gym main', code: 'ABC234', expires_at: '2026-10-07T00:05:00.000Z' });
});

describe('GET /api/pilot/gym-tvs', () => {
  it.each(['coach', 'organization_admin'])('%s lists the organization\'s TVs', async (role) => {
    as(role);
    const response = await GET(new NextRequest('http://localhost/api/pilot/gym-tvs'));
    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1');
  });

  it("legacy 'admin' is admitted as organization_admin (roleAlias.ts)", async () => {
    as('admin', 'acct-legacy-admin');
    const response = await GET(new NextRequest('http://localhost/api/pilot/gym-tvs'));
    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1');
  });

  it.each(['athlete', 'parent', 'platform_owner', 'board'])('%s is refused', async (role) => {
    as(role);
    const response = await GET(new NextRequest('http://localhost/api/pilot/gym-tvs'));
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('an unauthenticated caller is refused before any read', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    const response = await GET(new NextRequest('http://localhost/api/pilot/gym-tvs'));
    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/gym-tvs', () => {
  it('a coach mints a code for a named TV and gets it back once, 201', async () => {
    as('coach');
    const response = await POST(post({ tv_name: 'Gym main' }));
    expect(response.status).toBe(201);
    expect(mockMint).toHaveBeenCalledWith('org-1', 'acct-coach', 'Gym main');
    expect(await response.json()).toEqual({ tv: { tv_id: 'gymtv_1', tv_name: 'Gym main', code: 'ABC234', expires_at: '2026-10-07T00:05:00.000Z' } });
  });

  it('an organization admin may mint too', async () => {
    as('organization_admin', 'acct-admin');
    const response = await POST(post({ tv_name: 'House' }));
    expect(response.status).toBe(201);
    expect(mockMint).toHaveBeenCalledWith('org-1', 'acct-admin', 'House');
  });

  it("legacy 'admin' may mint too", async () => {
    as('admin', 'acct-legacy-admin');
    const response = await POST(post({ tv_name: 'House' }));
    expect(response.status).toBe(201);
    expect(mockMint).toHaveBeenCalledWith('org-1', 'acct-legacy-admin', 'House');
  });

  it.each(['athlete', 'parent', 'platform_owner'])('%s cannot mint', async (role) => {
    as(role);
    const response = await POST(post({ tv_name: 'x' }));
    expect(response.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('refuses a non-object body and extra fields before touching the module', async () => {
    as('coach');
    expect((await POST(post('not json'))).status).toBe(400);
    expect((await POST(post([1]))).status).toBe(400);
    const extra = await POST(post({ tv_name: 'x', organization_id: 'org-2' }));
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ error: 'UNEXPECTED_FIELD:organization_id' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("the module's refusals keep their status and code", async () => {
    as('coach');
    mockMint.mockRejectedValue(new GymTvError(429, 'TV_PAIR_CODE_RATE_LIMITED'));
    const response = await POST(post({ tv_name: 'x' }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'TV_PAIR_CODE_RATE_LIMITED', code: 'TV_PAIR_CODE_RATE_LIMITED' });
  });
});
