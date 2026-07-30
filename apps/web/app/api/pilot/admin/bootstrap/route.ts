import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearRateLimit } from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY?.trim() || '';
    const providedKey = request.headers.get('x-ppbf-bootstrap-key')?.trim() || '';

    if (!bootstrapKey) {
      throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
    }

    // Rate limiting: check per-IP
    const clientIp = getClientIp(request);
    const ipKey = `pin_bootstrap:${clientIp}`;

    const ipLimitCheck = checkRateLimit(ipKey);
    if (ipLimitCheck.isLimited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      );
    }

    if (!providedKey || providedKey !== bootstrapKey) {
      recordFailedAttempt(ipKey);
      throw new Error('Forbidden: invalid bootstrap key');
    }

    await request.json().catch(() => ({}));

    // Successful bootstrap key validation: clear rate limit
    clearRateLimit(ipKey);
    throw new Error(
      'Unsupported bootstrap path: privileged accounts must be Microsoft-authenticated. Use /api/pilot/admin/bootstrap/platform-owner-microsoft',
    );
  } catch (error) {
    return jsonError(error);
  }
}
