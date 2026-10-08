import { NextRequest } from 'next/server';

import { GET } from './route';
import { getWallDisplayNameMode } from '@/src/server/pilot/env';
import {
  GYM_TV_DEVICE_COOKIE,
  GYM_TV_READ_MAX_PER_ADDRESS,
  GYM_TV_READ_MAX_PER_KEY,
  type GymTvScreen,
  readGymTvScreen,
  resetGymTvReadBudget,
} from '@/src/server/pilot/gymTvs';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

jest.mock('@/src/server/pilot/gymTvs', () => ({
  ...jest.requireActual('@/src/server/pilot/gymTvs'),
  readGymTvScreen: jest.fn(),
}));

jest.mock('@/src/server/pilot/env', () => ({
  ...jest.requireActual('@/src/server/pilot/env'),
  getWallDisplayNameMode: jest.fn(() => undefined),
}));

const mockRead = jest.mocked(readGymTvScreen);
const mockMode = jest.mocked(getWallDisplayNameMode);

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

// The paired board: the one with people on it (OD-2026-10-07-008). Initials
// here, as the default name mode produces; the route passes it through.
const BOARD: WallBoard = {
  generated_at: '2026-10-07T18:04:00.000Z',
  gym_day: '2026-10-07',
  time_zone: 'America/New_York',
  name_mode: 'initials',
  sessions: [],
  on_floor: [{ key: 'ab12cd34ef56', name: 'M.R.', visibility: 'initials' }],
  on_floor_total: 1,
  marquee: [{ key: 'ab12cd34ef56-13', name: 'M.R.', visibility: 'initials', milestone: 13, crossed_on: '2026-10-06' }],
  notice: null,
};

const LIVE: GymTvScreen = {
  tv: { tv_name: 'Gym main' },
  board: BOARD,
  session: {
    run_id: 'ssrun_1',
    script_name: 'Tuesday fundamentals',
    total_minutes: 60,
    started_at: '2026-10-07T18:00:00.000Z',
    server_time: '2026-10-07T18:04:00.000Z',
    elapsed_seconds: 240,
    is_paused: false,
    current_block: { ...BLOCK, seconds_to_scheduled_end: 360 },
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
  mockMode.mockReturnValue(undefined);
  resetGymTvReadBudget();
});

it('a paired TV with a live session gets the session, and its cookie expiry slides', async () => {
  mockRead.mockResolvedValue(LIVE);
  const response = await read(KEY);
  expect(response.status).toBe(200);
  expect(mockRead).toHaveBeenCalledWith(KEY, { mode: 'initials' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(LIVE);
  // THE SLIDE: the same key, re-set with a fresh 400-day Max-Age, httpOnly, scoped to the TV routes.
  const cookie = response.cookies.get(GYM_TV_DEVICE_COOKIE);
  expect(cookie?.value).toBe(KEY);
  expect(cookie?.maxAge).toBe(400 * 24 * 60 * 60);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('lax');
  expect(cookie?.path).toBe('/api/pilot/tv');
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

// The route passes the module's result through; the allowlist itself is proved against the real
// database in gymTvs.pg.test.ts. This pins the route's own contribution: the body is the module's
// result and nothing more (no error field, no tv_id, no key).
it('the body is exactly the module result: nothing added by the route', async () => {
  mockRead.mockResolvedValue(LIVE);
  const body = (await (await read(KEY)).json()) as GymTvScreen;
  expect(body).toEqual(LIVE);
  expect(Object.keys(body).sort()).toEqual(['board', 'session', 'tv']);
  const serialized = JSON.stringify(body);
  for (const forbidden of [KEY, 'tv_id', 'error', 'what_to', 'account', 'athlete', 'hash', 'organization']) {
    expect(serialized).not.toContain(forbidden);
  }
});

// OD-2026-10-07-008, "Paired gym TV only": initials and milestones go only to a TV paired with a
// code. This route is that channel, and this test is the paired half of the ruling: the board with
// people on it rides here, behind the device key, and nowhere else.
it('the paired board, with initials and milestones, is served on this channel', async () => {
  mockRead.mockResolvedValue(LIVE);
  const body = (await (await read(KEY)).json()) as GymTvScreen;
  expect(body.board.on_floor).toEqual([{ key: 'ab12cd34ef56', name: 'M.R.', visibility: 'initials' }]);
  expect(body.board.marquee[0]).toMatchObject({ name: 'M.R.', milestone: 13 });
});

it("the operator's name mode reaches the paired board exactly as before; nothing unrecognised reaches 'consent'", async () => {
  mockRead.mockResolvedValue(LIVE);
  mockMode.mockReturnValue('consent');
  await read(KEY);
  expect(mockRead).toHaveBeenLastCalledWith(KEY, { mode: 'consent' });

  mockMode.mockReturnValue('yes please');
  await read(KEY);
  expect(mockRead).toHaveBeenLastCalledWith(KEY, { mode: 'initials' });

  mockMode.mockReturnValue('off');
  await read(KEY);
  expect(mockRead).toHaveBeenLastCalledWith(KEY, { mode: 'off' });
});

it('a paired TV with nothing on it gets session: null, still the board, and still the slide', async () => {
  mockRead.mockResolvedValue({ tv: { tv_name: 'House' }, session: null, board: BOARD });
  const response = await read(KEY);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tv: { tv_name: 'House' }, session: null, board: BOARD });
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)?.maxAge).toBe(400 * 24 * 60 * 60);
});

it('no cookie is a 401 (the empty key is looked up and refused), no-store, no cookie set, no board', async () => {
  mockRead.mockResolvedValue(null);
  const response = await read(null);
  expect(response.status).toBe(401);
  // Exactly the error: no board, public or otherwise, rides on an unpaired answer. The unpaired
  // screen goes to GET /api/pilot/wall for the public shape.
  expect(await response.json()).toEqual({ error: 'TV_NOT_PAIRED' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mockRead).toHaveBeenCalledWith('', { mode: 'initials' });
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
});

it('an unknown or disconnected key is a 401 with no session in the body; the cookie is left alone', async () => {
  mockRead.mockResolvedValue(null);
  const response = await read(KEY);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'TV_NOT_PAIRED' });
  // Not cleared: a stale poll answered after a re-pair must not wipe the key the TV just received.
  expect(response.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
});

it('one screen stuck in a loop hits its own per-key budget; the other screens on the same address do not', async () => {
  mockRead.mockResolvedValue(LIVE);
  for (let i = 0; i < GYM_TV_READ_MAX_PER_KEY; i += 1) {
    expect((await read(KEY)).status).toBe(200);
  }
  const refused = await read(KEY);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  expect(refused.headers.get('cache-control')).toBe('no-store');
  expect(await refused.json()).toEqual({ error: 'TV_READ_RATE_LIMITED' });
  // Refused before the lookup, and with no cookie change.
  expect(mockRead).toHaveBeenCalledTimes(GYM_TV_READ_MAX_PER_KEY);
  expect(refused.cookies.get(GYM_TV_DEVICE_COOKIE)).toBeUndefined();
  // Another TV behind the same gym address is unaffected.
  expect((await read('j'.repeat(64))).status).toBe(200);
});

it('seven TVs polling every 3 s for a minute from one address all stay under both budgets', async () => {
  mockRead.mockResolvedValue(LIVE);
  const keys = Array.from({ length: 7 }, (_, i) => String(i).repeat(64));
  for (let poll = 0; poll < 20; poll += 1) {
    for (const key of keys) {
      expect((await read(key)).status).toBe(200);
    }
  }
  expect(mockRead).toHaveBeenCalledTimes(140);
});

it('the per-address budget refuses a flood from one address even with no key, and another address is unaffected', async () => {
  mockRead.mockResolvedValue(null);
  for (let i = 0; i < GYM_TV_READ_MAX_PER_ADDRESS; i += 1) {
    expect((await read(null)).status).toBe(401);
  }
  expect((await read(null)).status).toBe(429);
  expect((await read(KEY)).status).toBe(429);
  expect((await read(null, '10.0.0.10')).status).toBe(401);
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
