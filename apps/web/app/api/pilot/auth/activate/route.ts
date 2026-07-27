import { NextResponse, type NextRequest } from 'next/server';

import { redeemActivationCode } from '@/src/server/pilot/activation';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import { checkRateLimit, clearRateLimit, getClientIp, recordFailedAttempt } from '@/src/server/pilot/rateLimit';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

export const runtime = 'nodejs';

/**
 * Redeems an activation code and sets the athlete's own PIN.
 *
 * Unauthenticated by design -- this is an athlete's first contact with the
 * system, before they have any credential. The code is the sole bearer
 * credential, so this endpoint is rate limited per IP and every failure
 * returns the same message regardless of whether the code was wrong, expired,
 * already used, or belonged to a suspended organization.
 *
 * On success the athlete is signed straight in via the ordinary
 * athlete PIN login path, so no session is minted by any logic other than the
 * one already covering normal logins.
 */
export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const ipKey = `activate_ip:${clientIp}`;

  try {
    // Checked before parsing so a limited caller cannot keep the endpoint busy.
    if (checkRateLimit(ipKey).isLimited) {
      return NextResponse.json(
        { error: 'Too many activation attempts. Please try again later.' },
        { status: 429 },
      );
    }

    const body = (await request.json()) as { code?: string; pin?: string };
    const code = body.code?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!code || !pin) {
      throw new Error('Missing code or pin');
    }

    let redeemed;
    try {
      redeemed = await redeemActivationCode(code, pin);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';

      // A malformed PIN is the athlete's own correctable mistake and does not
      // consume the code, so it must not count toward the brute-force budget
      // or the athlete locks themselves out while fixing a typo. Anything
      // else is a failed guess at the code.
      if (!message.startsWith('PIN')) {
        recordFailedAttempt(ipKey);
      }

      throw error;
    }

    clearRateLimit(ipKey);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: redeemed.accountId,
      actor_role: 'athlete',
      organization_id: redeemed.organizationId,
      entity_type: 'account',
      entity_id: redeemed.accountId,
      details: {
        action: 'athlete_self_activation',
        athlete_id: redeemed.athleteId,
      },
    });

    // Sign the athlete in with the PIN they just chose, through the same
    // function that serves the login route. If this does not succeed for any
    // reason, activation still stands -- report success and let them sign in
    // from the login page rather than implying the PIN did not take.
    const loginResult = await loginWithAccountIdAndPin(redeemed.accountId, pin);

    const response = NextResponse.json({
      ok: true,
      account_id: redeemed.accountId,
      organization_id: redeemed.organizationId,
      athlete_id: redeemed.athleteId,
      signed_in: Boolean(loginResult),
    });

    if (loginResult) {
      await writePilotAuditEvent({
        event_type: 'login',
        actor_account_id: loginResult.principal.accountId,
        actor_role: loginResult.principal.role,
        organization_id: loginResult.principal.organizationId,
        entity_type: 'account',
        entity_id: loginResult.principal.accountId,
        details: { athlete_id: loginResult.principal.athleteId, via: 'activation' },
      });

      response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_ABSOLUTE_LIFETIME_SECONDS,
      });
    }

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
