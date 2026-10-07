import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { GymTvError, disconnectGymTv } from '@/src/server/pilot/gymTvs';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  disconnectGymTv: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockDisconnect = jest.mocked(disconnectGymTv);

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: 'acct-coach',
    organizationId: 'org-1',
    role,
  } as Awaited<ReturnType<typeof requirePrincipal>>);
}

function call(tvId: string) {
  return POST(
    new NextRequest(`http://localhost/api/pilot/gym-tvs/${tvId}/disconnect`, { method: 'POST' }),
    { params: Promise.resolve({ tvId }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDisconnect.mockResolvedValue({
    tv_id: 'gymtv_1',
    tv_name: 'Gym main',
    status: 'disconnected',
    created_by_account_id: 'acct-coach',
    created_at: '2026-10-07T00:00:00.000Z',
    pair_code_expires_at: null,
    paired_at: '2026-10-07T00:01:00.000Z',
    last_seen_at: null,
    revoked_at: '2026-10-07T01:00:00.000Z',
    current_run_id: null,
    current_run_set_by_account_id: null,
  });
});

it.each(['coach', 'organization_admin'])('%s disconnects a TV in their organization', async (role) => {
  as(role);
  const response = await call('gymtv_1');
  expect(response.status).toBe(200);
  expect(mockDisconnect).toHaveBeenCalledWith('org-1', 'gymtv_1');
  expect((await response.json()).tv.status).toBe('disconnected');
});

it.each(['athlete', 'parent', 'platform_owner'])('%s is refused', async (role) => {
  as(role);
  expect((await call('gymtv_1')).status).toBe(403);
  expect(mockDisconnect).not.toHaveBeenCalled();
});

it('a TV the module does not find is a 404', async () => {
  as('coach');
  mockDisconnect.mockRejectedValue(new GymTvError(404, 'TV_NOT_FOUND'));
  const response = await call('gymtv_other');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'TV_NOT_FOUND', code: 'TV_NOT_FOUND' });
});

it('a blank id is a 400 before any write', async () => {
  as('coach');
  expect((await call(' ')).status).toBe(400);
  expect(mockDisconnect).not.toHaveBeenCalled();
});
