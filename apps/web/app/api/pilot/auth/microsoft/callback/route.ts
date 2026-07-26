import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

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
    const primaryOwnerEmail = (process.env.PPBF_PRIMARY_OWNER_EMAIL?.trim() || 'admin@punxsyprominence.org').toLowerCase();
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

    if (loginResult.principal.role === 'platform_owner' && identityEmail !== primaryOwnerEmail) {
      throw new Error('Forbidden: platform owner identity mismatch');
    }

    const destinationPath = getPilotRoleDestination(loginResult.principal.role);
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
    clearTempCookies(response);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown auth error';

    if (message.startsWith('Unauthorized: missing authorization response') || message.startsWith('Unauthorized: invalid state')) {
      return redirectToLogin(publicOrigin, 'auth-state-expired');
    }

    if (message.startsWith('Forbidden:')) {
      return redirectToLogin(publicOrigin, 'auth-forbidden');
    }

    return redirectToLogin(publicOrigin, 'auth-failed');
  }
}
