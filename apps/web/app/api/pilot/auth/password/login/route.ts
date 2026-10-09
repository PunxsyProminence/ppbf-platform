import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import { loginWithEmailAndPassword, MAX_LOGIN_EMAIL_LENGTH } from '@/src/server/pilot/parentPasswordSignIn';
import { clearDurableRateLimit, getClientIp, reserveAttempts } from '@/src/server/pilot/rateLimit';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

export const runtime = 'nodejs';

// The session is already minted when this runs, so a lost audit row must not
// turn a correct sign-in into a 500 -- the PIN route's own doctrine.
async function auditPasswordLogin(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'pilot-auth-password-login-audit-write-failed',
      ...(code ? { code } : {}),
    });
  }
}

// One body for every refusal, whichever limit or check produced it.
function invalidCredentials(): NextResponse {
  return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
}

function tooManyAttempts(): NextResponse {
  return NextResponse.json(
    { error: 'Too many sign-in attempts. Please wait a few minutes.' },
    { status: 429 },
  );
}

/**
 * A parent signs in with email and password.
 *
 * Who is admitted is decided in parentPasswordSignIn.ts, which re-reads the
 * account on every sign-in. This route adds the attempt limit, the one answer
 * every refusal gets, the audit row and the cookie.
 *
 * THE LIMIT: the existing limiter (rateLimit.ts), durable and volatile, per
 * email and per IP -- the slow-down the athlete PIN has, and no lockout. Two
 * things differ from the PIN route (auth/login/route.ts), both on purpose.
 *
 * Every attempt is COUNTED BEFORE THE PASSWORD IS VERIFIED, not after it
 * fails. This route needs no session and a verification is a 33 MB scrypt. If
 * only failures were counted, any number of requests arriving together would
 * all pass the check before the first of them had failed. Counted first, one
 * of a burst reaches the verification and the rest wait.
 *
 * The buckets are keyed by the EMAIL AS TYPED, known or not, so being made to
 * wait says nothing about whether the address has an account.
 *
 * A success clears both buckets, as the PIN route does. Leaving the IP count
 * in place would make a sign-up night at the gym, everyone on one address,
 * wait longer with each parent who signs in correctly.
 */
export async function POST(request: NextRequest) {
  try {
    // `?? {}`: a body of literal null parses, and is not an object to read from.
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    // Not trimmed: a space at either end is part of the password as typed.
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      throw new Error('Missing email or password');
    }

    const ipKey = `password_login_ip:${getClientIp(request)}`;

    // An address too long to be one is never a bucket key. It is held to the
    // caller's IP bucket like any other attempt -- made to wait when that is
    // full, counted when it is not -- and refused like a wrong credential.
    if (email.length > MAX_LOGIN_EMAIL_LENGTH) {
      if ((await reserveAttempts([ipKey])).isLimited) {
        return tooManyAttempts();
      }
      return invalidCredentials();
    }

    const emailKey = `password_login_email:${email}`;

    // Counted and checked in one step (reserveAttempts, CL-A4). In memory
    // this route already did both in one tick; the durable half read every
    // bucket and only then wrote, so requests arriving together on different
    // replicas all passed the read. Each durable reservation is now one
    // conditional upsert that exactly one concurrent writer wins.
    if ((await reserveAttempts([emailKey, ipKey])).isLimited) {
      return tooManyAttempts();
    }

    const loginResult = await loginWithEmailAndPassword(email, password);

    if (!loginResult) {
      return invalidCredentials();
    }

    await clearDurableRateLimit(emailKey);
    await clearDurableRateLimit(ipKey);

    await auditPasswordLogin({
      event_type: 'login',
      actor_account_id: loginResult.principal.accountId,
      actor_role: loginResult.principal.role,
      organization_id: loginResult.principal.organizationId,
      entity_type: 'account',
      entity_id: loginResult.principal.accountId,
      details: { auth_provider: 'password' },
    });

    const response = NextResponse.json({
      ok: true,
      account_id: loginResult.principal.accountId,
      role: loginResult.principal.role,
      organization_id: loginResult.principal.organizationId,
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
