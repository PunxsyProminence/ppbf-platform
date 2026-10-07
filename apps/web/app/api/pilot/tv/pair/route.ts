import { NextResponse, type NextRequest } from 'next/server';

import {
  GYM_TV_DEVICE_COOKIE,
  GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  isWellFormedPairCode,
  normalizePairCode,
  redeemGymTvPairCode,
} from '@/src/server/pilot/gymTvs';
import {
  checkDurableRateLimit,
  checkRateLimit,
  clearDurableRateLimit,
  getClientIp,
  recordDurableFailedAttempt,
  recordFailedAttempt,
} from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

/**
 * POST /api/pilot/tv/pair -- the TV types the code from the coach dashboard.
 *
 * Unauthenticated by construction: the TV has no session and never gets one. The one-time code is
 * the credential. On success the TV receives its device key in an httpOnly cookie and nothing in
 * the body but the TV's name; the key opens only the TV read (S2b).
 *
 * A per-IP budget sits in FRONT of the lookup, on both the volatile and the durable limiter, the
 * way magic-link consume does it: there is no account to key on, and the code space is small
 * enough (32^6) that an unbudgeted endpoint could be walked. Every failure returns the same answer
 * whether the code was wrong, expired, already used, or belonged to a disconnected TV.
 */
export async function POST(request: NextRequest) {
  const ipKey = `tv_pair_ip:${getClientIp(request)}`;

  const volatileCheck = checkRateLimit(ipKey);
  const durableCheck = await checkDurableRateLimit(ipKey);
  if (volatileCheck.isLimited || durableCheck.isLimited) {
    return NextResponse.json({ error: 'TV_PAIR_RATE_LIMITED' }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as unknown;
  const rawCode =
    body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : '';
  const code = normalizePairCode(rawCode);
  if (!isWellFormedPairCode(code)) {
    // A malformed code is counted too: it is still a guess from this address.
    recordFailedAttempt(ipKey);
    await recordDurableFailedAttempt(ipKey);
    return NextResponse.json({ error: 'TV_PAIR_CODE_INVALID' }, { status: 400 });
  }

  let redeemed: Awaited<ReturnType<typeof redeemGymTvPairCode>>;
  try {
    redeemed = await redeemGymTvPairCode(code);
  } catch (error) {
    console.error('tv-pair-redeem-failed', { message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  if (!redeemed) {
    recordFailedAttempt(ipKey);
    await recordDurableFailedAttempt(ipKey);
    return NextResponse.json({ error: 'TV_PAIR_CODE_REJECTED' }, { status: 404 });
  }

  await clearDurableRateLimit(ipKey);

  const response = NextResponse.json({ ok: true, tv_name: redeemed.tv_name });
  response.cookies.set(GYM_TV_DEVICE_COOKIE, redeemed.device_key, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
