import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { loginWithMicrosoftEmail } from '@/src/server/pilot/auth';
import { PILOT_SESSION_COOKIE } from '@/src/server/pilot/env';
import {
  exchangeCodeForIdToken,
  fetchOidcDiscovery,
  getMsOidcConfig,
  resolveMicrosoftIdentityEmail,
  verifyAndDecodeMicrosoftIdToken,
} from '@/src/server/pilot/federatedAuth';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const STATE_COOKIE = 'ppbf_ms_auth_state';
const VERIFIER_COOKIE = 'ppbf_ms_auth_verifier';
const NONCE_COOKIE = 'ppbf_ms_auth_nonce';

function routeForRole(role: string): string {
  if (role === 'athlete') {
    return '/athlete/dashboard';
  }
  if (role === 'coach') {
    return '/coach/review-queue';
  }
  if (role === 'parent') {
    return '/parent/dashboard';
  }
  return '/admin';
}

function clearTempCookies(response: NextResponse): void {
  response.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(VERIFIER_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(NONCE_COOKIE, '', { path: '/', maxAge: 0 });
}

export async function GET(request: NextRequest) {
  try {
    const primaryOwnerEmail = (process.env.PPBF_PRIMARY_OWNER_EMAIL?.trim() || 'admin@punxsyprominence.org').toLowerCase();
    const config = getMsOidcConfig();
    const queryState = request.nextUrl.searchParams.get('state')?.trim() || '';
    const code = request.nextUrl.searchParams.get('code')?.trim() || '';

    if (!queryState || !code) {
      throw new Error('Unauthorized: missing authorization response');
    }

    const cookieStore = await cookies();
    const expectedState = cookieStore.get(STATE_COOKIE)?.value?.trim() || '';
    const codeVerifier = cookieStore.get(VERIFIER_COOKIE)?.value?.trim() || '';
    const expectedNonce = cookieStore.get(NONCE_COOKIE)?.value?.trim() || '';

    if (!expectedState || !codeVerifier || !expectedNonce || queryState !== expectedState) {
      throw new Error('Unauthorized: invalid state');
    }

    const discovery = await fetchOidcDiscovery(config.tenantId);
    const idToken = await exchangeCodeForIdToken(discovery, config, code, codeVerifier);
    const claims = await verifyAndDecodeMicrosoftIdToken({
      idToken,
      discovery,
      config,
      expectedNonce,
    });

    const identityEmail = resolveMicrosoftIdentityEmail(claims);
    const loginResult = await loginWithMicrosoftEmail(identityEmail);

    if (!loginResult) {
      const denied = NextResponse.redirect(new URL('/login?error=not-invited', request.url));
      clearTempCookies(denied);
      return denied;
    }

    if (loginResult.principal.role === 'platform_owner' && identityEmail !== primaryOwnerEmail) {
      throw new Error('Forbidden: platform owner identity mismatch');
    }

    const defaultPostLogin = routeForRole(loginResult.principal.role);
    const destination = new URL(config.postLoginPath || defaultPostLogin, request.url);
    const response = NextResponse.redirect(destination);
    response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    clearTempCookies(response);
    return response;
  } catch (error) {
    return jsonError(error, 401);
  }
}
