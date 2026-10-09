import { NextResponse, type NextRequest } from 'next/server';

import { redeemActivationCode } from '@/src/server/pilot/activation';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import { assertChosenPinAllowed, validatePinPolicy } from '@/src/server/pilot/pinPolicy';
import { clearDurableRateLimit, getClientIp, reserveAttempts } from '@/src/server/pilot/rateLimit';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

export const runtime = 'nodejs';

// A lost audit row must not report an already-committed activation (or the
// login that follows it) as a failure -- same non-fatal-audit doctrine as
// parent/consent's auditConsentEvent. Both call sites below run AFTER their
// respective write already committed, so a throw here previously turned a
// successful activation, or a successful post-activation sign-in, into a
// 500 the athlete had no way to distinguish from a real failure.
async function auditActivationEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'pilot-auth-activation-audit-write-failed',
      activation_event_type: event.event_type,
      ...(code ? { code } : {}),
    });
  }
}

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
 *
 * EVERY CODE GUESS IS COUNTED BEFORE IT IS CHECKED (CL-A4). Reading the
 * bucket, awaiting the redemption and recording the failure afterwards let
 * every guess in a burst past the read before the first failure landed. The
 * IP is the only key there is -- no account exists until the code resolves --
 * so it is reserved, as the TV pairing code's is. The cost, accepted: of two
 * athletes activating in the same second from the gym's one IP, the second is
 * told to wait (Retry-After). A success clears the bucket.
 */
export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const ipKey = `activate_ip:${clientIp}`;

  try {
    const body = (await request.json()) as { code?: string; pin?: string };
    const code = body.code?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!code || !pin) {
      throw new Error('Missing code or pin');
    }

    /* A malformed PIN is the athlete's own correctable mistake and does not
       consume the code, so it must not count toward the brute-force budget or
       the athlete locks themselves out while fixing a typo. So the PIN's rules
       run BEFORE the attempt is counted: the same two checks
       redeemActivationCode runs first, pure and synchronous, each throwing
       ValidationError (a 400).

       This used to be decided after the redemption failed, by error type, and
       before that by message prefix -- which missed PIN_TRIVIALLY_GUESSABLE
       ("That PIN is too easy to guess") and charged an athlete trying 111111,
       then 123123, then 112233 three failed CODE guesses. Deciding before
       counting removes the question. */
    validatePinPolicy(pin);
    assertChosenPinAllowed(pin);

    const reservation = await reserveAttempts([ipKey]);
    if (reservation.isLimited) {
      return NextResponse.json(
        { error: 'Too many activation attempts. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(reservation.delayMs / 1000) || 1) },
        },
      );
    }

    // Already counted above: a failed redemption records nothing more.
    const redeemed = await redeemActivationCode(code, pin);

    await clearDurableRateLimit(ipKey);

    await auditActivationEvent({
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
      await auditActivationEvent({
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
