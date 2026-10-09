import { NextResponse, type NextRequest } from 'next/server';

import { changeOwnPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError, requirePrincipalAllowingPinChange } from '@/src/server/pilot/http';
import { assertChosenPinAllowed, validatePinPolicy } from '@/src/server/pilot/pinPolicy';
import {
  checkRateLimit,
  checkDurableRateLimit,
  clearDurableRateLimit,
  getClientIp,
  recordDurableFailedAttempt,
  reserveAttempts,
} from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

function tooManyAttempts(): NextResponse {
  return NextResponse.json(
    { error: 'Too many attempts. Please try again later.' },
    { status: 429 },
  );
}

/**
 * The one route an account still holding its bootstrap PIN may call, hence
 * requirePrincipalAllowingPinChange rather than requirePrincipal.
 *
 * It is rate limited on the same footing as login because it takes the
 * current PIN as input: without a limit it would be a second, unthrottled
 * place to guess one.
 *
 * Durable, not just volatile, for the same reason login is: a session
 * cookie alone gets a caller in here (requirePrincipalAllowingPinChange
 * checks the session, not the current PIN), so a holder of a stolen-but-live
 * session can guess the current PIN repeatedly. The in-memory limiter is
 * per-container, so across Container Apps' multiple replicas that guesser's
 * real budget is N times the intended 5-attempts-then-backoff design. Either
 * limiter saying "limited" is enough.
 *
 * THE ACCOUNT IS COUNTED BEFORE THE CURRENT PIN IS CHECKED (CL-A4), as on
 * login: reading the bucket, awaiting scrypt and recording the failure
 * afterwards let every guess in a burst past the read before the first
 * failure landed. The new PIN's own rules run first, so a PIN the athlete is
 * still choosing costs nothing.
 *
 * THE IP BUCKET STAYS CHECK-THEN-RECORD, as on login. A class changing its
 * starting PINs together shares the gym's one public IP; reserving it would
 * hold every other tablet off for the length of each correct change.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipalAllowingPinChange(request);

    const clientIp = getClientIp(request);
    const accountKey = `pin_change_account:${principal.accountId}`;
    const ipKey = `pin_change_ip:${clientIp}`;

    const durableAccountCheck = await checkDurableRateLimit(accountKey);
    const durableIpCheck = await checkDurableRateLimit(ipKey);
    if (
      checkRateLimit(accountKey).isLimited
      || checkRateLimit(ipKey).isLimited
      || durableAccountCheck.isLimited
      || durableIpCheck.isLimited
    ) {
      return tooManyAttempts();
    }

    const body = (await request.json().catch(() => ({}))) as { current_pin?: string; new_pin?: string };
    const currentPin = body.current_pin?.trim() || '';
    const newPin = body.new_pin?.trim() || '';

    if (!currentPin || !newPin) {
      throw new Error('Missing current_pin or new_pin');
    }

    // The three checks changeOwnPin runs before it reads the stored PIN, run
    // here so they decide before the attempt is counted. Pure and synchronous,
    // and none says anything about the stored PIN.
    validatePinPolicy(newPin);
    assertChosenPinAllowed(newPin);
    if (currentPin === newPin) {
      throw new Error('PIN must be different from the current PIN');
    }

    if ((await reserveAttempts([accountKey])).isLimited) {
      return tooManyAttempts();
    }

    try {
      await changeOwnPin(principal.accountId, currentPin, newPin);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unauthorized')) {
        // The account attempt is already counted; the IP one is recorded here.
        await recordDurableFailedAttempt(ipKey);
      }
      throw error;
    }

    await clearDurableRateLimit(accountKey);
    await clearDurableRateLimit(ipKey);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: principal.accountId,
      details: { action: 'change_own_pin', from_bootstrap_pin: principal.mustChangePin },
    });

    // changeOwnPin revoked every session for this account, including this
    // one, so the cookie in the browser is now pointing at a dead token.
    // Clearing it makes the client's next step an explicit sign-in with the
    // new PIN rather than a confusing bounce off a revoked session.
    const response = NextResponse.json({
      ok: true,
      account_id: principal.accountId,
      next_step: 'Sign in again with your new PIN.',
    });
    response.cookies.delete(PILOT_SESSION_COOKIE);
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
