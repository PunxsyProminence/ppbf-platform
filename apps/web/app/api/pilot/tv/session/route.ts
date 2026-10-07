import { NextResponse, type NextRequest } from 'next/server';

import {
  GYM_TV_DEVICE_COOKIE,
  GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  consumeGymTvReadBudget,
  readGymTvSession,
} from '@/src/server/pilot/gymTvs';
import { getClientIp } from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

/**
 * GET /api/pilot/tv/session -- what the paired TV shows (gym TV lane, S2b).
 *
 * Unauthenticated by construction: the TV has no session and never gets one. The credential is
 * the device key in the httpOnly cookie that /api/pilot/tv/pair set, resolved by hash; it opens
 * this read and nothing else. The payload is the fixed allowlist in gymTvs.ts (the plan's blocks,
 * times and drill names, where the coach is, the server clock) and carries no person: no coach
 * notes, no names, no account ids, no roster.
 *
 *   401 TV_NOT_PAIRED  no key, an unknown key, or a disconnected TV. The cookie is cleared so the
 *                      TV falls back to the code box cleanly (S3).
 *   200 session: null  paired, but nothing is on this TV: no session sent, or the run has ended or
 *                      been switched off the TV.
 *   200 session: {..}  the live session.
 *
 * Each successful keyed read re-sets the cookie with a fresh Max-Age, so "until disconnected"
 * (Jason) holds for a TV that is used: the 400-day cap counts from the last read, not from the
 * day it was paired.
 *
 * Budgeted per address with a fixed window (gymTvs.ts consumeGymTvReadBudget), not the auth
 * limiter: a TV is supposed to poll forever.
 */
export async function GET(request: NextRequest) {
  const budget = consumeGymTvReadBudget(`tv_read_ip:${getClientIp(request)}`);
  if (!budget.allowed) {
    return NextResponse.json(
      { error: 'TV_READ_RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
    );
  }

  const deviceKey = request.cookies.get(GYM_TV_DEVICE_COOKIE)?.value ?? '';

  let read: Awaited<ReturnType<typeof readGymTvSession>>;
  try {
    read = await readGymTvSession(deviceKey);
  } catch (error) {
    // Class and driver code only: this log line is reachable by an unauthenticated caller, and a
    // pg error's message can carry the host name or SQL text.
    console.error('tv-session-read-failed', {
      name: error instanceof Error ? error.constructor.name : typeof error,
      code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const cookieAttributes = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };

  if (!read) {
    const response = NextResponse.json({ error: 'TV_NOT_PAIRED' }, { status: 401 });
    if (deviceKey) {
      response.cookies.set(GYM_TV_DEVICE_COOKIE, '', { ...cookieAttributes, maxAge: 0 });
    }
    return response;
  }

  const response = NextResponse.json(read, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(GYM_TV_DEVICE_COOKIE, deviceKey, {
    ...cookieAttributes,
    maxAge: GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
