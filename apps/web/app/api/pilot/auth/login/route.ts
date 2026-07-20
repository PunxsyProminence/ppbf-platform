import { NextResponse, type NextRequest } from 'next/server';

import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearRateLimit } from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { account_id?: string; pin?: string };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    // Rate limiting: check per-account and per-IP
    const clientIp = getClientIp(request);
    const accountKey = `pin_account:${accountId}`;
    const ipKey = `pin_ip:${clientIp}`;

    const accountLimitCheck = checkRateLimit(accountKey);
    const ipLimitCheck = checkRateLimit(ipKey);

    if (accountLimitCheck.isLimited) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        { status: 429 }
      );
    }

    if (ipLimitCheck.isLimited) {
      return NextResponse.json(
        { error: 'Too many login attempts from this IP. Please try again later.' },
        { status: 429 }
      );
    }

    // Attempt login
    const loginResult = await loginWithAccountIdAndPin(accountId, pin);

    if (!loginResult) {
      // Failed login: record failed attempt for rate limiting
      recordFailedAttempt(accountKey);
      recordFailedAttempt(ipKey);

      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Successful login: clear rate limits
    clearRateLimit(accountKey);
    clearRateLimit(ipKey);

    // Use the authenticated role from the database, never override it
    const finalRole = loginResult.principal.role;

    await writePilotAuditEvent({
      event_type: 'login',
      actor_account_id: loginResult.principal.accountId,
      actor_role: finalRole,
      organization_id: loginResult.principal.organizationId,
      entity_type: 'account',
      entity_id: loginResult.principal.accountId,
      details: { athlete_id: loginResult.principal.athleteId },
    });

    const response = NextResponse.json({
      ok: true,
      account_id: loginResult.principal.accountId,
      role: finalRole,
      organization_id: loginResult.principal.organizationId,
      athlete_id: loginResult.principal.athleteId,
    });

    response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
