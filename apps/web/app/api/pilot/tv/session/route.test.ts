import { NextRequest } from 'next/server';

import { GET } from './route';
import {
  GYM_TV_BLOCK_FIELDS,
  GYM_TV_DEVICE_COOKIE,
  GYM_TV_READ_MAX_PER_WINDOW,
  GYM_TV_SESSION_FIELDS,
  type GymTvRead,
  readGymTvSession,
  resetGymTvReadBudget,
} from '@/src/server/pilot/gymTvs';

jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  readGymTvSession: jest.fn(),
}));

const mockRead = jest.mocked(readGymTvSession);

const KEY = 'k'.repeat(64);
const IP = '10.0.0.9';

const BLOCK = {
  block_id: 'blk-1',
  block_order: 1,
  block_label: 'Slip and visual response',
  block_kind: 'drill_round',
  drill_name: 'Slip line',
  scale_level: 'B',
  start_offset_min: 0,
  end_offset_min: 10,
};

const LIVE: GymTvRead = {
  tv: { tv_name: 'Gym main' },
  session: {
    run_id: 'ssrun_1',
    script_name: 'Tuesday fundamentals',
    total_minutes: 60,
    started_at: '2026-10-07T18:00:00.000Z',
    server_time: '2026-10-07T18:04:00.000Z',
    elapsed_seconds: 240,
    is_paused: false,
    current_block: { ...BLOCK, seconds_left: 360 },
    next_block: { ...BLOCK, block_id: 'blk-2', block_order: 2, start_offset_min: 10, end_offset_min: 20 },
    blocks: [BLOCK, { ...BLOCK, block_id: 'blk-2', block_order: 2, start_offset_min: 10, end_offset_min: 20 }],
  },
};

function read(key: string | null, ip = IP) {
  const headers: Record<string, string> = { 'x-real-ip': ip };
  if (key !== null) headers.cookie = `${GYM_TV_DEVICE_COOKIE}=${key}`;
  return GET(new NextRequest('http://localhost/api/pilot/tv/session', { method: 'GET', headers }));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetGymTvReadBudget();
});

it('a paired TV with a live session gets the session, and its cookie expiry slides', async () => {
  mockRead.mockResolvedValue(LIVE);
  const response = await read(KEY);
  expect(response.status).toBe(200);
  expect(mockRead).toHaveBeenCalledWith(KEY);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(LIVE);
  // THE SLIDE: the same key, re-set with a fresh 400-day Max-Age, httpOnly, path /.
  const cookie = response.cookies.get(GYM_TV_DEVICE_COOKIE);
  expect(cookie?.value).toBe(KEY);
  expect(cookie?.maxAge).toBe(400 * 24 * 60 * 60);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('lax');
  expect(cookie?.path).toBe('/');
});

it('under NODE_ENV=production the re-set cookie is Secure', async () => {
  mockRead.mockResolvedValue(LIVE);
  const env = process.env as { NODE_ENV?: string };
  const before = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    const response = await read(KEY);
    expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)?.secure).toBe(true);
  } finally {
    env.NODE_ENV = before;
  }
});

it('the body never carries a field outside the allowlist, whatever the module returns', async () => {
  mockRead.mockResolvedValue(LIVE);
  const body = (await (await read(KEY)).json()) as GymTvRead;
  expect(Object.keys(body).sort()).toEqual(['session', 'tv']);
  expect(Object.keys(body.tv)).toEqual(['tv_name']);
  expect(Object.keys(body.session as object).sort()).toEqual([...GYM_TV_SESSION_FIELDS].sort());
  for (const block of (body.session as NonNullable<GymTvRead['session']>).blocks) {
    expect(Object.keys(block).sort()).toEqual([...GYM_TV_BLOCK_FIELDS].sort());
  }
  const serialized = JSON.stringify(body);
  for (const forbidden of ['what_to', 'account', 'athlete', 'coach', 'delivered_by', 'hash', 'organization']) {
    expect(serialized).not.toContain(forbidden);
  }
});

it('a paired TV with nothing on it gets session: null and still the slide', async () => {
  mockRead.mockResolvedValue({ tv: { tv_name: 'House' }, session: null });
  const response = await read(KEY);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tv: { tv_name: 'House' }, session: null });
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)?.maxAge).toBe(400 * 24 * 60 * 60);
});

it('no cookie is a 401 with no lookup of an empty key and nothing to clear', async () => {
  mockRead.mockResolvedValue(null);
  const response = await read(null);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'TV_NOT_PAIRED' });
  expect(mockRead).toHaveBeenCalledWith('');
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
});

it('an unknown or disconnected key is a 401, the cookie is cleared, and no session is in the body', async () => {
  mockRead.mockResolvedValue(null);
  const response = await read(KEY);
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body).toEqual({ error: 'TV_NOT_PAIRED' });
  const cookie = response.cookies.get(GYM_TV_DEVICE_COOKIE);
  expect(cookie?.value).toBe('');
  expect(cookie?.maxAge).toBe(0);
});

it('the per-address budget refuses with 429 and Retry-After after the window is spent; another address is unaffected', async () => {
  mockRead.mockResolvedValue(LIVE);
  for (let i = 0; i < GYM_TV_READ_MAX_PER_WINDOW; i += 1) {
    expect((await read(KEY)).status).toBe(200);
  }
  const refused = await read(KEY);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  expect(await refused.json()).toEqual({ error: 'TV_READ_RATE_LIMITED' });
  // Refused before the lookup, and with no cookie change.
  expect(mockRead).toHaveBeenCalledTimes(GYM_TV_READ_MAX_PER_WINDOW);
  expect(refused.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
  expect((await read(KEY, '10.0.0.10')).status).toBe(200);
});

it('a database fault is a plain 500: no session, no cookie change, class and code in the log and nothing else', async () => {
  const fault = Object.assign(new Error('connection refused to host db.internal'), { code: 'ECONNREFUSED' });
  mockRead.mockRejectedValue(fault);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const response = await read(KEY);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('db.internal');
    expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('db.internal');
  } finally {
    spy.mockRestore();
  }
});
