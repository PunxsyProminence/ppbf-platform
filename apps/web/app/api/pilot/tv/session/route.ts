import { NextResponse, type NextRequest } from 'next/server';

import { getWallDisplayNameMode } from '@/src/server/pilot/env';
import {
  GYM_TV_DEVICE_COOKIE,
  GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  GYM_TV_DEVICE_COOKIE_PATH,
  consumeGymTvReadBudget,
  readGymTvScreen,
} from '@/src/server/pilot/gymTvs';
import { getClientIp } from '@/src/server/pilot/rateLimit';
import { resolveWallNameMode } from '@/src/server/pilot/wallDisplay';

export const runtime = 'nodejs';

/**
 * GET /api/pilot/tv/session -- what the paired TV shows (gym TV lane, S2b).
 *
 * Unauthenticated by construction: the TV has no session and never gets one. The credential is
 * the device key in the httpOnly cookie that /api/pilot/tv/pair set, resolved by hash; it opens
 * this read and nothing else. The payload is two things:
 *
 *   session  the fixed allowlist in gymTvs.ts (the plan's blocks, times and drill names, where
 *            the coach is, the server clock), no person field: no coach notes, no names, no
 *            account ids, no roster.
 *   board    the wall board WITH people on it: initials (or more, per the operator's name mode and
 *            the consent gate in wallDisplay.ts), milestone crossings, and notices placed
 *            'everywhere'. OD-2026-10-07-008 (Jason, "Paired gym TV only"): this is the only
 *            place that board is served. The public address, GET /api/pilot/wall, serves classes
 *            and a head count and nothing about anyone. The board's organization is the paired TV
 *            row's, never the caller's.
 *
 *   401 TV_NOT_PAIRED  no key, an unknown key, or a disconnected TV. The cookie is left alone: a
 *                      stale poll answered after a re-pair must not wipe the key the TV just
 *                      received (reviewer B), so the TV page decides when to pair again, and
 *                      pairing overwrites the cookie. No board of any kind in this response: an
 *                      unpaired screen falls back to the public read.
 *   200 session: null  paired, but nothing is on this TV: no session sent, or the run has ended or
 *                      been switched off the TV. The board is still there.
 *   200 session: {..}  the live session, and the board.
 *
 * Each successful keyed read re-sets the cookie with a fresh Max-Age, so "until disconnected"
 * (Jason) holds for a TV that is used: the 400-day cap counts from the last read, not from the
 * day it was paired. The cookie is scoped to /api/pilot/tv, so the key travels with no other
 * request.
 *
 * Budgeted per address AND per key on fixed windows (gymTvs.ts consumeGymTvReadBudget), not the
 * auth limiter: a TV is supposed to poll forever, and one stuck screen must not starve the rest.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const deviceKey = request.cookies.get(GYM_TV_DEVICE_COOKIE)?.value ?? '';

  const budget = consumeGymTvReadBudget(getClientIp(request), deviceKey);
  if (!budget.allowed) {
    return NextResponse.json(
      { error: 'TV_READ_RATE_LIMITED' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(budget.retryAfterSeconds) } },
    );
  }

  let read: Awaited<ReturnType<typeof readGymTvScreen>>;
  try {
    read = await readGymTvScreen(deviceKey, { mode: resolveWallNameMode(getWallDisplayNameMode()) });
  } catch (error) {
    // Class and driver code only: this log line is reachable by an unauthenticated caller, and a
    // pg error's message can carry the host name or SQL text.
    console.error('tv-session-read-failed', {
      name: error instanceof Error ? error.constructor.name : typeof error,
      code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }

  if (!read) {
    return NextResponse.json({ error: 'TV_NOT_PAIRED' }, { status: 401, headers: NO_STORE });
  }

  const response = NextResponse.json(read, { headers: NO_STORE });
  response.cookies.set(GYM_TV_DEVICE_COOKIE, deviceKey, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: GYM_TV_DEVICE_COOKIE_PATH,
    maxAge: GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
