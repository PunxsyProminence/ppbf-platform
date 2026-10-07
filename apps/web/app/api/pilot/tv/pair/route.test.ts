import { NextRequest } from 'next/server';

import { POST } from './route';
import { GYM_TV_DEVICE_COOKIE, redeemGymTvPairCode } from '@/src/server/pilot/gymTvs';
import {
  clearDurableRateLimit,
  clearRateLimit,
  getRateLimitStatus,
  reserveAttempts,
} from '@/src/server/pilot/rateLimit';

jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  redeemGymTvPairCode: jest.fn(),
}));
// The volatile limiter stays real: reserveAttempts is wrapped so its calls can be seen and one
// test can stand in for the durable half saying "blocked", but by default it runs the real thing
// (the durable store is off in this process: no flag, no connection string). The durable clear
// needs a database, so it is stubbed and observed.
jest.mock('@/src/server/pilot/rateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/rateLimit');
  return {
    ...actual,
    reserveAttempts: jest.fn(actual.reserveAttempts),
    clearDurableRateLimit: jest.fn(async () => undefined),
  };
});

const mockRedeem = jest.mocked(redeemGymTvPairCode);
const mockReserve = jest.mocked(reserveAttempts);
const mockDurableClear = jest.mocked(clearDurableRateLimit);

const IP = '10.0.0.7';
const KEY = `tv_pair_ip:${IP}`;

function pair(body: unknown, ip = IP, existingKey: string | null = null) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': ip };
  if (existingKey !== null) headers.cookie = `${GYM_TV_DEVICE_COOKIE}=${existingKey}`;
  return POST(
    new NextRequest('http://localhost/api/pilot/tv/pair', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function paired() {
  mockRedeem.mockResolvedValue({ device_key: 'k'.repeat(64), organization_id: 'org-1', tv_id: 'gymtv_1', tv_name: 'Gym main' });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearRateLimit(KEY);
});

it('a good code pairs the TV: key in an httpOnly cookie, never in the body', async () => {
  paired();
  const response = await pair({ code: 'abc-234' });
  expect(response.status).toBe(200);
  // No cookie on the request: nothing to revoke.
  expect(mockRedeem).toHaveBeenCalledWith('ABC234', null);
  expect(await response.json()).toEqual({ ok: true, tv_name: 'Gym main' });
  const cookie = response.cookies.get(GYM_TV_DEVICE_COOKIE);
  expect(cookie?.value).toBe('k'.repeat(64));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('lax');
  expect(cookie?.path).toBe('/');
  expect(cookie?.maxAge).toBe(400 * 24 * 60 * 60);
  // Not secure here: NODE_ENV is 'test'. The production case is the next test.
  expect(cookie?.secure).toBeFalsy();
  // The attempt was reserved before anything else, and success cleared the buckets on both halves.
  expect(mockReserve).toHaveBeenCalledWith([KEY]);
  expect(mockDurableClear).toHaveBeenCalledWith(KEY);
});

it('a TV that already holds a key hands it to the redeem, so its old row is revoked; the new key replaces it', async () => {
  paired();
  const response = await pair({ code: 'ABC234' }, IP, 'old'.repeat(20));
  expect(response.status).toBe(200);
  expect(mockRedeem).toHaveBeenCalledWith('ABC234', 'old'.repeat(20));
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)?.value).toBe('k'.repeat(64));
});

it('under NODE_ENV=production the cookie is Secure', async () => {
  paired();
  const env = process.env as { NODE_ENV?: string };
  const before = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    const response = await pair({ code: 'ABC234' });
    expect(response.status).toBe(200);
    const cookie = response.cookies.get(GYM_TV_DEVICE_COOKIE);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
  } finally {
    env.NODE_ENV = before;
  }
});

it('a rejected code is a 404 with no cookie; the attempt stays counted and nothing is cleared', async () => {
  mockRedeem.mockResolvedValue(null);
  const response = await pair({ code: 'ABC234' });
  expect(response.status).toBe(404);
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
  expect(getRateLimitStatus(KEY).count).toBe(1);
  expect(mockDurableClear).not.toHaveBeenCalled();
});

it('a malformed code is a 400, counted, and never looked up', async () => {
  for (const body of [{ code: 'AB' }, { code: 'ABC2340' }, { code: 'ABC2O1' }, { code: 7 }, {}, 'nope']) {
    // Each malformed guess counts against the address (the volatile limiter backs off after a
    // few), so the budget is reset between shapes to see every shape's own answer.
    clearRateLimit(KEY);
    const response = await pair(body);
    expect(response.status).toBe(400);
    expect(getRateLimitStatus(KEY).count).toBe(1);
  }
  expect(mockRedeem).not.toHaveBeenCalled();
  expect(mockReserve).toHaveBeenCalledTimes(6);
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
  clearRateLimit('tv_pair_ip:10.0.0.8');
});

it('the durable limiter alone is enough to refuse, before the body is read', async () => {
  mockReserve.mockResolvedValueOnce({ isLimited: true, key: KEY, durable: true, delayMs: 1000 });
  // A malformed body: if the body were parsed before the reservation this would be a 400.
  expect((await pair('nope')).status).toBe(429);
  expect(mockRedeem).not.toHaveBeenCalled();
});

it('ten guesses arriving together: at most one reaches the lookup, the rest are 429', async () => {
  // A slow wrong answer, the shape of a row lock: every request is in flight before the first one
  // learns it failed. Check-then-record would have let all ten through.
  mockRedeem.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 20)));
  const responses = await Promise.all(Array.from({ length: 10 }, () => pair({ code: 'ABC234' })));
  const statuses = responses.map((r) => r.status);
  // Exactly one, not "at most": all ten reservations check-and-record synchronously before any
  // request yields (the first await in reserveAttempts is the durable half), well inside the
  // 1 s first backoff, so this cannot flake, and zero would mean a bucket leaked from another test.
  expect(mockRedeem).toHaveBeenCalledTimes(1);
  expect(statuses.filter((s) => s === 429)).toHaveLength(9);
  expect(statuses.filter((s) => s === 404)).toHaveLength(1);
});

it('a database fault is a plain 500, not a 404 that would read as a wrong code; the log carries class and code, not the message', async () => {
  const fault = Object.assign(new Error('connection refused to host db.internal'), { code: 'ECONNREFUSED' });
  mockRedeem.mockRejectedValue(fault);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const response = await pair({ code: 'ABC234' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('db.internal');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('db.internal');
    expect(mockDurableClear).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
