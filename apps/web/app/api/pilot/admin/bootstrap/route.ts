import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import {
  getClientIp,
  checkRateLimit,
  checkDurableRateLimit,
  recordDurableFailedAttempt,
  clearDurableRateLimit,
} from '@/src/server/pilot/rateLimit';
import { bootstrapKeyMatches } from '@/src/server/pilot/security';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY?.trim() || '';

    if (!bootstrapKey) {
      throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
    }

    // Rate limiting: check per-IP. Durable, not just volatile -- this route
    // always refuses below, but it still distinguishes a correct key from a
    // wrong one via which error message comes back ("invalid bootstrap key"
    // vs "Unsupported bootstrap path"), which is a live oracle for guessing
    // PPBF_PILOT_BOOTSTRAP_KEY even though it never grants access. It shares
    // the platform-owner-microsoft route's bucket key by design, and both
    // sides of that shared budget need to be durable or a guesser can drain
    // the volatile-only side for free per container replica.
    const clientIp = getClientIp(request);
    const ipKey = `pin_bootstrap:${clientIp}`;

    const ipLimitCheck = checkRateLimit(ipKey);
    const durableIpCheck = await checkDurableRateLimit(ipKey);
    if (ipLimitCheck.isLimited || durableIpCheck.isLimited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      );
    }

    if (!bootstrapKeyMatches(request.headers, bootstrapKey)) {
      await recordDurableFailedAttempt(ipKey);
      throw new Error('Forbidden: invalid bootstrap key');
    }

    await request.json().catch(() => ({}));

    // Successful bootstrap key validation: clear rate limit
    await clearDurableRateLimit(ipKey);
    throw new Error(
      'Unsupported bootstrap path: privileged accounts must be Microsoft-authenticated. Use /api/pilot/admin/bootstrap/platform-owner-microsoft',
    );
  } catch (error) {
    return jsonError(error);
  }
}
