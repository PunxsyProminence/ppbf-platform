import { NextResponse, type NextRequest } from 'next/server';

import {
  GYM_TV_DEVICE_COOKIE,
  GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  GYM_TV_DEVICE_COOKIE_PATH,
  isWellFormedPairCode,
  normalizePairCode,
  redeemGymTvPairCode,
} from '@/src/server/pilot/gymTvs';
import { clearDurableRateLimit, getClientIp, reserveAttempts } from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

/**
 * POST /api/pilot/tv/pair -- the TV types the code from the coach dashboard.
 *
 * Unauthenticated by construction: the TV has no session and never gets one. The one-time code is
 * the credential. On success the TV receives its device key in an httpOnly cookie and nothing in
 * the body but the TV's name; the key opens only the TV read (S2b).
 *
 * A per-IP budget sits in FRONT of the lookup, on both the volatile and the durable limiter, and
 * the attempt is COUNTED BEFORE IT IS CHECKED (reserveAttempts, CL-A4): there is no account to key
 * on, and the code space is small enough (32^6) that an unbudgeted endpoint could be walked. The
 * reservation happens before the body is even read, so a malformed guess costs the same as a wrong
 * one, and of a burst of guesses in flight together at most one reaches the lookup (per replica,
 * if the durable store is unreachable). Success clears the buckets; failure records nothing more,
 * because the attempt was already charged.
 *
 * Every failed lookup (wrong, expired, already used, or belonging to a disconnected TV) returns the
 * same 404, so a guesser learns nothing about which codes are live.
 */
export async function POST(request: NextRequest) {
  const ipKey = `tv_pair_ip:${getClientIp(request)}`;

  const reservation = await reserveAttempts([ipKey]);
  if (reservation.isLimited) {
    return NextResponse.json({ error: 'TV_PAIR_RATE_LIMITED' }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as unknown;
  const rawCode =
    body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : '';
  const code = normalizePairCode(rawCode);
  if (!isWellFormedPairCode(code)) {
    // Already counted by the reservation above: a malformed code is still a guess from this address.
    return NextResponse.json({ error: 'TV_PAIR_CODE_INVALID' }, { status: 400 });
  }

  // A TV that already holds a key and pairs again: the row that key names is revoked in the same
  // transaction (gymTvs.ts redeemGymTvPairCode), so one device never holds two live rows.
  const previousKey = request.cookies.get(GYM_TV_DEVICE_COOKIE)?.value ?? null;

  let redeemed: Awaited<ReturnType<typeof redeemGymTvPairCode>>;
  try {
    redeemed = await redeemGymTvPairCode(code, previousKey || null);
  } catch (error) {
    // Class and driver code only. A pg error's message can carry the host name or SQL text, and
    // this log line is reachable by an unauthenticated caller. The constructor name, not
    // error.name: pg's DatabaseError sets name to the literal 'error'.
    console.error('tv-pair-redeem-failed', {
      name: error instanceof Error ? error.constructor.name : typeof error,
      code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  if (!redeemed) {
    return NextResponse.json({ error: 'TV_PAIR_CODE_REJECTED' }, { status: 404 });
  }

  await clearDurableRateLimit(ipKey);

  const response = NextResponse.json({ ok: true, tv_name: redeemed.tv_name });
  response.cookies.set(GYM_TV_DEVICE_COOKIE, redeemed.device_key, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    // Scoped to the TV routes (S2b): the key travels with no other request.
    path: GYM_TV_DEVICE_COOKIE_PATH,
    maxAge: GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
