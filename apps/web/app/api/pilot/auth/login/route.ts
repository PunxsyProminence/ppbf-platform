import { NextResponse, type NextRequest } from 'next/server';

import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import {
  getClientIp,
  checkRateLimit,
  checkDurableRateLimit,
  recordDurableFailedAttempt,
  reserveAttempts,
  clearDurableRateLimit,
} from '@/src/server/pilot/rateLimit';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

export const runtime = 'nodejs';

// A lost audit row must not tell an athlete who typed the correct PIN that
// the server is broken -- same non-fatal-audit doctrine as parent/consent's
// auditConsentEvent and compliance/violations' auditViolationEvent. Without
// this, a transient audit-write failure turned an already-correct login into
// a 500 raised before the session cookie was ever set.
async function auditLoginEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'pilot-auth-login-audit-write-failed',
      ...(code ? { code } : {}),
    });
  }
}

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

    // Volatile AND durable, the way /auth/activate already does it. The
    // in-memory limiter alone was the only brake on a 6-digit athlete PIN,
    // and it is per-process: N container replicas meant N independent attempt
    // budgets against the same child's account, and every deploy reset every
    // lockout to zero. pilot.accounts has no failed-attempt column, so
    // nothing else survived a restart.
    //
    // Either limiter saying "limited" is enough. A durable lookup that cannot
    // reach the database returns not-limited rather than throwing, so a blip
    // degrades to the volatile limiter instead of locking every athlete out
    // -- failing this check closed would be a worse outage than the brute
    // force it guards against.
    //
    // THE ACCOUNT IS COUNTED BEFORE THE PIN IS CHECKED (CL-A4). Reading the
    // bucket, awaiting scrypt and recording the failure afterwards let every
    // guess in a burst at one child's PIN past the read before the first
    // failure landed. reserveAttempts counts this attempt atomically and
    // admits it only if the account bucket was not already blocked.
    //
    // THE IP BUCKET STAYS CHECK-THEN-RECORD, deliberately. Reserving it would
    // block the gym's other tablets (one public IP) for the length of every
    // CORRECT sign-in, so a class signing in together would read 429s. It
    // still slows a spray across accounts after each failure, as before.
    const ipLimitCheck = checkRateLimit(ipKey);
    const durableIpCheck = await checkDurableRateLimit(ipKey);
    if (ipLimitCheck.isLimited || durableIpCheck.isLimited) {
      return NextResponse.json(
        {
          error: ipLimitCheck.isLimited
            ? 'Too many login attempts from this IP. Please try again later.'
            : 'Too many login attempts. Please try again later.',
        },
        { status: 429 }
      );
    }

    const reservation = await reserveAttempts([accountKey]);
    if (reservation.isLimited) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        { status: 429 }
      );
    }

    // Attempt login
    const loginResult = await loginWithAccountIdAndPin(accountId, pin);

    if (!loginResult) {
      // The account attempt is already counted; the IP one is recorded here.
      await recordDurableFailedAttempt(ipKey);
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Successful login: clear both stores, so a legitimate athlete who
    // fat-fingered their PIN a few times is not still throttled by a durable
    // row after they get it right.
    await clearDurableRateLimit(accountKey);
    await clearDurableRateLimit(ipKey);

    // Use the authenticated role from the database, never override it
    const finalRole = loginResult.principal.role;
    const hasMasterShadowAccess = loginResult.principal.hasMasterShadowAccess || false;

    await auditLoginEvent({
      event_type: 'login',
      actor_account_id: loginResult.principal.accountId,
      actor_role: finalRole,
      organization_id: loginResult.principal.organizationId,
      entity_type: 'account',
      entity_id: loginResult.principal.accountId,
      details: { athlete_id: loginResult.principal.athleteId, hasMasterShadowAccess },
    });

    const response = NextResponse.json({
      ok: true,
      account_id: loginResult.principal.accountId,
      role: finalRole,
      organization_id: loginResult.principal.organizationId,
      athlete_id: loginResult.principal.athleteId,
      has_master_shadow_access: hasMasterShadowAccess,
    });

    response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_ABSOLUTE_LIFETIME_SECONDS,
    });

    return response;
  } catch (error) {
    return jsonError(error);
  }
}
