import { NextRequest } from 'next/server';

import { DELETE, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { GymTvError, sendRunToGymTv, takeRunOffGymTv } from '@/src/server/pilot/gymTvs';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  sendRunToGymTv: jest.fn(),
  takeRunOffGymTv: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockSend = jest.mocked(sendRunToGymTv);
const mockTakeOff = jest.mocked(takeRunOffGymTv);

const TV = {
  tv_id: 'gymtv_1',
  tv_name: 'Gym main',
  status: 'paired' as const,
  created_by_account_id: 'acct-coach',
  created_at: '2026-10-07T00:00:00.000Z',
  pair_code_expires_at: null,
  paired_at: '2026-10-07T00:01:00.000Z',
  last_seen_at: '2026-10-07T00:02:00.000Z',
  revoked_at: null,
  current_run_id: 'ssrun_1',
  current_run_set_by_account_id: 'acct-coach',
};

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: 'acct-coach',
    organizationId: 'org-1',
    role,
  } as Awaited<ReturnType<typeof requirePrincipal>>);
}

function send(tvId: string, body: unknown) {
  return POST(
    new NextRequest(`http://localhost/api/pilot/gym-tvs/${tvId}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ tvId }) },
  );
}

function takeOff(tvId: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/pilot/gym-tvs/${tvId}/session`, { method: 'DELETE' }),
    { params: Promise.resolve({ tvId }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue(TV);
  mockTakeOff.mockResolvedValue({ ...TV, current_run_id: null, current_run_set_by_account_id: null });
});

describe('POST: send the session to a TV', () => {
  // 'admin' is the legacy row spelling of organization_admin (roleAlias.ts) and must be admitted too.
  it.each(['coach', 'organization_admin', 'admin'])('%s sends their run to a TV in their organization', async (role) => {
    as(role);
    const response = await send('gymtv_1', { run_id: ' ssrun_1 ' });
    expect(response.status).toBe(200);
    // The organization and the account come from the session, never the body, and the id is trimmed.
    expect(mockSend).toHaveBeenCalledWith('org-1', 'acct-coach', 'gymtv_1', 'ssrun_1');
    expect((await response.json()).tv.current_run_id).toBe('ssrun_1');
  });

  it.each(['athlete', 'parent', 'platform_owner'])('%s is refused', async (role) => {
    as(role);
    expect((await send('gymtv_1', { run_id: 'ssrun_1' })).status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a missing, blank or non-string run_id and any extra field are 400 before any write', async () => {
    as('coach');
    for (const body of [{}, { run_id: '' }, { run_id: '  ' }, { run_id: 7 }, { run_id: 'ssrun_1', tv_name: 'x' }, 'nope', [1]]) {
      expect((await send('gymtv_1', body)).status).toBe(400);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a blank TV id is a 400 before any write', async () => {
    as('coach');
    expect((await send(' ', { run_id: 'ssrun_1' })).status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'TV_NOT_FOUND'],
    [404, 'SESSION_RUN_NOT_FOUND'],
    [409, 'SESSION_RUN_NOT_LIVE'],
    [409, 'SESSION_RUN_NOT_ON_TV'],
    [409, 'TV_NOT_PAIRED'],
    [409, 'TV_IN_USE'],
  ])("the module's %s %s reaches the caller with its code", async (status, code) => {
    as('coach');
    mockSend.mockRejectedValue(new GymTvError(status, code));
    const response = await send('gymtv_1', { run_id: 'ssrun_1' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, code });
  });
});

describe('DELETE: take the session off a TV', () => {
  it.each(['coach', 'organization_admin', 'admin'])('%s takes the session off', async (role) => {
    as(role);
    const response = await takeOff('gymtv_1');
    expect(response.status).toBe(200);
    expect(mockTakeOff).toHaveBeenCalledWith('org-1', 'acct-coach', 'gymtv_1');
    expect((await response.json()).tv.current_run_id).toBeNull();
  });

  it.each(['athlete', 'parent', 'platform_owner'])('%s is refused', async (role) => {
    as(role);
    expect((await takeOff('gymtv_1')).status).toBe(403);
    expect(mockTakeOff).not.toHaveBeenCalled();
  });

  it("another coach's live session on the TV is a 409 TV_IN_USE", async () => {
    as('coach');
    mockTakeOff.mockRejectedValue(new GymTvError(409, 'TV_IN_USE'));
    const response = await takeOff('gymtv_1');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'TV_IN_USE', code: 'TV_IN_USE' });
  });

  it('a blank TV id is a 400 before any write', async () => {
    as('coach');
    expect((await takeOff(' ')).status).toBe(400);
    expect(mockTakeOff).not.toHaveBeenCalled();
  });
});
