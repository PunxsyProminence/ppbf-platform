import { NextRequest } from 'next/server';

import { POST } from './route';
import { GYM_TV_DEVICE_COOKIE, redeemGymTvPairCode } from '@/src/server/pilot/gymTvs';
import {
  checkDurableRateLimit,
  clearDurableRateLimit,
  clearRateLimit,
  recordDurableFailedAttempt,
} from '@/src/server/pilot/rateLimit';

jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  redeemGymTvPairCode: jest.fn(),
}));
// The volatile limiter stays real (it is what the 429 test drives). The durable one needs a
// database, so it is stubbed to "not limited" and its recording is observed.
jest.mock('@/src/server/pilot/rateLimit', () => ({
  ...jest.requireActual('@/src/server/pilot/rateLimit'),
  checkDurableRateLimit: jest.fn(async () => ({ isLimited: false })),
  recordDurableFailedAttempt: jest.fn(async () => ({ delayMs: 0 })),
  clearDurableRateLimit: jest.fn(async () => undefined),
}));

const mockRedeem = jest.mocked(redeemGymTvPairCode);
const mockDurableCheck = jest.mocked(checkDurableRateLimit);
const mockDurableRecord = jest.mocked(recordDurableFailedAttempt);
const mockDurableClear = jest.mocked(clearDurableRateLimit);

const IP = '10.0.0.7';

function pair(body: unknown, ip = IP) {
  return POST(
    new NextRequest('http://localhost/api/pilot/tv/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  clearRateLimit(`tv_pair_ip:${IP}`);
  mockDurableCheck.mockResolvedValue({ isLimited: false });
});

it('a good code pairs the TV: key in an httpOnly cookie, never in the body', async () => {
  mockRedeem.mockResolvedValue({ device_key: 'k'.repeat(64), organization_id: 'org-1', tv_id: 'gymtv_1', tv_name: 'Gym main' });
  const response = await pair({ code: 'abc-234' });
  expect(response.status).toBe(200);
  expect(mockRedeem).toHaveBeenCalledWith('ABC234');
  expect(await response.json()).toEqual({ ok: true, tv_name: 'Gym main' });
  const cookie = response.cookies.get(GYM_TV_DEVICE_COOKIE);
  expect(cookie?.value).toBe('k'.repeat(64));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('lax');
  expect(cookie?.path).toBe('/');
  expect(cookie?.maxAge).toBe(400 * 24 * 60 * 60);
  expect(mockDurableClear).toHaveBeenCalledWith(`tv_pair_ip:${IP}`);
  expect(mockDurableRecord).not.toHaveBeenCalled();
});

it('a rejected code is a 404 with no cookie, and the failure is recorded on both limiters', async () => {
  mockRedeem.mockResolvedValue(null);
  const response = await pair({ code: 'ABC234' });
  expect(response.status).toBe(404);
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
  expect(mockDurableRecord).toHaveBeenCalledWith(`tv_pair_ip:${IP}`);
});

it('a malformed code is a 400, counted, and never looked up', async () => {
  for (const body of [{ code: 'AB' }, { code: 'ABC2340' }, { code: 'ABC2O1' }, { code: 7 }, {}, 'nope']) {
    // Each malformed guess counts against the address (the volatile limiter backs off after a
    // few), so the budget is reset between shapes to see every shape's own answer.
    clearRateLimit(`tv_pair_ip:${IP}`);
    const response = await pair(body);
    expect(response.status).toBe(400);
  }
  expect(mockRedeem).not.toHaveBeenCalled();
  expect(mockDurableRecord).toHaveBeenCalledTimes(6);
});

it('the volatile limiter blocks this address after repeated failures, before any lookup', async () => {
  mockRedeem.mockResolvedValue(null);
  let status = 0;
  for (let i = 0; i < 20 && status !== 429; i += 1) {
    status = (await pair({ code: 'ABC234' })).status;
  }
  expect(status).toBe(429);
  const calls = mockRedeem.mock.calls.length;
  expect((await pair({ code: 'ABC234' })).status).toBe(429);
  expect(mockRedeem.mock.calls.length).toBe(calls);
  // Another address is unaffected.
  expect((await pair({ code: 'ABC234' }, '10.0.0.8')).status).toBe(404);
});

it('the durable limiter alone is enough to refuse', async () => {
  mockDurableCheck.mockResolvedValue({ isLimited: true, delayMs: 1000 });
  expect((await pair({ code: 'ABC234' })).status).toBe(429);
  expect(mockRedeem).not.toHaveBeenCalled();
});

it('a database fault is a plain 500, not a 404 that would read as a wrong code', async () => {
  mockRedeem.mockRejectedValue(new Error('connection refused to host db.internal'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await pair({ code: 'ABC234' });
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain('db.internal');
  expect(mockDurableRecord).not.toHaveBeenCalled();
  spy.mockRestore();
});
