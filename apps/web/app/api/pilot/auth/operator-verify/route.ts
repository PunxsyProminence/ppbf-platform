import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearRateLimit } from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { pin?: string };
    const providedPin = body.pin?.trim() || '';

    const requiredPin = process.env.PPBF_OPERATOR_PIN?.trim();
    if (!requiredPin) {
      throw new Error('Server misconfiguration: PPBF_OPERATOR_PIN is required');
    }

    // Rate limiting: check per-IP only (no account context)
    const clientIp = getClientIp(request);
    const ipKey = `pin_operator:${clientIp}`;

    const ipLimitCheck = checkRateLimit(ipKey);
    if (ipLimitCheck.isLimited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      );
    }

    if (!providedPin || providedPin !== requiredPin) {
      recordFailedAttempt(ipKey);
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 });
    }

    // Successful verification: clear rate limit
    clearRateLimit(ipKey);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
