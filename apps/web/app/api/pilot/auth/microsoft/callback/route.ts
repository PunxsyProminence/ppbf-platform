import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { listSeatsForAccount, resolveLandingSeat } from '@/src/server/pilot/boardSeats';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';
import { loginWithMicrosoftEmail } from '@/src/server/pilot/auth';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import {
  MICROSOFT_AUTH_ISSUED_AT_COOKIE,
  MICROSOFT_AUTH_NONCE_COOKIE,
  MICROSOFT_AUTH_STATE_COOKIE,
  MICROSOFT_AUTH_USED_STATE_COOKIE,
  MICROSOFT_AUTH_VERIFIER_COOKIE,
  fingerprintValue,
  hashStateForReplayGuard,
  resolvePublicOrigin,
  shouldEmitAuthDiagnostics,
  shouldUseSecureCookie,
  validateOAuthState,
} from '@/src/server/pilot/microsoftOAuthFlow';
import {
  exchangeCodeForIdToken,
  fetchOidcDiscovery,
  getMsOidcConfig,
  resolveMicrosoftIdentityEmail,
  verifyAndDecodeMicrosoftIdToken,
} from '@/src/server/pilot/federatedAuth';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

export const runtime = 'nodejs';

// A lost audit row must not refuse a sign-in that already happened -- the same
// non-fatal-audit doctrine as login/route.ts and magic-link/consume/route.ts.
// It matters more here than on either of those: loginWithMicrosoftEmail has
// already inserted the pilot.session_tokens row by the time this runs, and
// every throw inside the handler below lands in a catch that redirects to
// /login?error=auth-failed. An unwrapped write would therefore turn a
// transient database blip into an admin who cannot get in, holding a live
// session they were never handed the cookie for.
async function auditMicrosoftLoginEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'pilot-auth-microsoft-audit-write-failed',
      ...(code ? { code } : {}),
    });
  }
}

function clearTempCookies(response: NextResponse): void {
  response.cookies.set(MICROSOFT_AUTH_STATE_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(MICROSOFT_AUTH_VERIFIER_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(MICROSOFT_AUTH_NONCE_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(MICROSOFT_AUTH_ISSUED_AT_COOKIE, '', { path: '/', maxAge: 0 });
}

function redirectToLogin(publicOrigin: string, error: string): NextResponse {
  const response = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, publicOrigin));
  response.headers.set('Cache-Control', 'no-store');
  clearTempCookies(response);
  return response;
}

interface OAuthCallbackCookies {
  expectedState: string;
  codeVerifier: string;
  expectedNonce: string;
  issuedAtRaw: string;
  usedStateHash: string;
}

function readOAuthCallbackCookies(cookieStore: Awaited<ReturnType<typeof cookies>>): OAuthCallbackCookies {
  return {
    expectedState: cookieStore.get(MICROSOFT_AUTH_STATE_COOKIE)?.value?.trim() || '',
    codeVerifier: cookieStore.get(MICROSOFT_AUTH_VERIFIER_COOKIE)?.value?.trim() || '',
    expectedNonce: cookieStore.get(MICROSOFT_AUTH_NONCE_COOKIE)?.value?.trim() || '',
    issuedAtRaw: cookieStore.get(MICROSOFT_AUTH_ISSUED_AT_COOKIE)?.value?.trim() || '',
    usedStateHash: cookieStore.get(MICROSOFT_AUTH_USED_STATE_COOKIE)?.value?.trim() || '',
  };
}

function logInvalidStateDiagnostic(input: {
  request: NextRequest;
  reason: string;
  queryState: string;
  cookies: OAuthCallbackCookies;
}): void {
  if (!shouldEmitAuthDiagnostics()) {
    return;
  }

  console.info('auth.microsoft.callback.invalid_state', {
    route: input.request.nextUrl.pathname,
    host: input.request.nextUrl.host,
    protocol: input.request.nextUrl.protocol,
    forwardedProto: input.request.headers.get('x-forwarded-proto') || 'none',
    reason: input.reason,
    hasStateCookie: Boolean(input.cookies.expectedState),
    hasVerifierCookie: Boolean(input.cookies.codeVerifier),
    hasNonceCookie: Boolean(input.cookies.expectedNonce),
    hasIssuedAtCookie: Boolean(input.cookies.issuedAtRaw),
    queryStateLength: input.queryState.length,
    queryStateFingerprint: fingerprintValue(input.queryState),
    cookieStateLength: input.cookies.expectedState.length,
    cookieStateFingerprint: fingerprintValue(input.cookies.expectedState),
    reusedStateDetected: input.reason === 'reused-state',
  });
}

function logValidStateDiagnostic(request: NextRequest, queryState: string): void {
  if (!shouldEmitAuthDiagnostics()) {
    return;
  }

  console.info('auth.microsoft.callback.state_validated', {
    route: request.nextUrl.pathname,
    host: request.nextUrl.host,
    protocol: request.nextUrl.protocol,
    forwardedProto: request.headers.get('x-forwarded-proto') || 'none',
    queryStateLength: queryState.length,
    queryStateFingerprint: fingerprintValue(queryState),
  });
}

function validateStateOrThrow(input: {
  request: NextRequest;
  queryState: string;
  code: string;
  cookies: OAuthCallbackCookies;
}): void {
  const issuedAtEpochSeconds = input.cookies.issuedAtRaw ? Number.parseInt(input.cookies.issuedAtRaw, 10) : null;

  const validation = validateOAuthState({
    queryState: input.queryState,
    code: input.code,
    expectedState: input.cookies.expectedState,
    codeVerifier: input.cookies.codeVerifier,
    expectedNonce: input.cookies.expectedNonce,
    issuedAtEpochSeconds,
    usedStateHash: input.cookies.usedStateHash,
  });

  if (!validation.ok) {
    logInvalidStateDiagnostic({
      request: input.request,
      reason: validation.reason,
      queryState: input.queryState,
      cookies: input.cookies,
    });
    throw new Error(`Unauthorized: invalid state (${validation.reason})`);
  }

  logValidStateDiagnostic(input.request, input.queryState);
}

export async function GET(request: NextRequest) {
  const config = getMsOidcConfig();
  const publicOrigin = resolvePublicOrigin({
    requestUrl: request.url,
    forwardedHostHeader: request.headers.get('x-forwarded-host'),
    forwardedProtoHeader: request.headers.get('x-forwarded-proto'),
    fallbackOrigin: new URL(config.callbackUrl).origin,
  });

  try {
    const queryState = request.nextUrl.searchParams.get('state')?.trim() || '';
    const code = request.nextUrl.searchParams.get('code')?.trim() || '';

    if (!queryState || !code) {
      throw new Error('Unauthorized: missing authorization response');
    }

    const cookieStore = await cookies();
    const callbackCookies = readOAuthCallbackCookies(cookieStore);
    validateStateOrThrow({
      request,
      queryState,
      code,
      cookies: callbackCookies,
    });

    const discovery = await fetchOidcDiscovery(config.tenantId);
    const idToken = await exchangeCodeForIdToken(discovery, config, code, callbackCookies.codeVerifier);
    const claims = await verifyAndDecodeMicrosoftIdToken({
      idToken,
      discovery,
      config,
      expectedNonce: callbackCookies.expectedNonce,
    });

    const identityEmail = resolveMicrosoftIdentityEmail(claims);
    const loginResult = await loginWithMicrosoftEmail(identityEmail);

    if (!loginResult) {
      return redirectToLogin(publicOrigin, 'not-invited');
    }

    // A board member lands on the seat they hold rather than the shared hub,
    // so the seat has to be resolved before the redirect is built. Everyone
    // else routes on role alone.
    const landingSeat = loginResult.principal.role === 'board'
      ? resolveLandingSeat(
        await listSeatsForAccount(loginResult.principal.organizationId, loginResult.principal.accountId),
      )
      : null;

    // loginWithMicrosoftEmail refuses an unroutable role before it mints a
    // token, so this always resolves; it is read here for the redirect path.
    const destinationPath = getPilotRoleDestination(loginResult.principal.role, landingSeat);
    if (!destinationPath) {
      throw new Error('Forbidden: unsupported authenticated role');
    }
    const destination = new URL(destinationPath, publicOrigin);
    const response = NextResponse.redirect(destination);
    response.headers.set('Cache-Control', 'no-store');
    const secure = shouldUseSecureCookie({
      nextUrlProtocol: request.nextUrl.protocol,
      forwardedProtoHeader: request.headers.get('x-forwarded-proto'),
      nodeEnv: process.env.NODE_ENV,
    });

    response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: SESSION_ABSOLUTE_LIFETIME_SECONDS,
    });
    response.cookies.set(MICROSOFT_AUTH_USED_STATE_COOKIE, hashStateForReplayGuard(queryState), {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    // The door that recorded nothing. PIN and magic-link have written a 'login'
    // row since each shipped; this route wrote none -- and it is the only way
    // in for platform_owner, organization_admin, admin and board, so the
    // highest-privilege sign-ins on a platform holding children's records were
    // the only ones leaving no trace. For a youth-serving organization that is
    // a safeguarding gap, not a bookkeeping one.
    //
    // Deliberately last, after the destination check: a role that fails that
    // check is refused, and refusals are not recorded anywhere on this
    // platform's auth paths (auditEventTypes.ts has no failure type). Writing
    // before the check would put a 'login' row under a sign-in that did not
    // happen, which is worse than the silence it replaced.
    await auditMicrosoftLoginEvent({
      event_type: 'login',
      actor_account_id: loginResult.principal.accountId,
      actor_role: loginResult.principal.role,
      organization_id: loginResult.principal.organizationId,
      entity_type: 'account',
      entity_id: loginResult.principal.accountId,
      details: {
        auth_provider: 'microsoft',
        hasMasterShadowAccess: loginResult.principal.hasMasterShadowAccess || false,
      },
    });

    clearTempCookies(response);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown auth error';

    // Always logged, not gated behind PPBF_AUTH_DIAGNOSTICS: a sign-in that
    // fails here redirects the user to /login with a generic code, so without
    // this the only record of why production auth broke is gone.
    console.error('auth.microsoft.callback.failed', {
      route: request.nextUrl.pathname,
      host: request.nextUrl.host,
      message,
    });

    if (message.startsWith('Unauthorized: missing authorization response') || message.startsWith('Unauthorized: invalid state')) {
      return redirectToLogin(publicOrigin, 'auth-state-expired');
    }

    if (message.startsWith('Forbidden:')) {
      return redirectToLogin(publicOrigin, 'auth-forbidden');
    }

    return redirectToLogin(publicOrigin, 'auth-failed');
  }
}
