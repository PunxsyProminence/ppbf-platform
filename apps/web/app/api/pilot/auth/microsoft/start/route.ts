import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import {
  MICROSOFT_AUTH_ISSUED_AT_COOKIE,
  MICROSOFT_AUTH_NONCE_COOKIE,
  MICROSOFT_AUTH_STATE_COOKIE,
  MICROSOFT_AUTH_USED_STATE_COOKIE,
  MICROSOFT_AUTH_VERIFIER_COOKIE,
  fingerprintValue,
  resolveCanonicalAuthStartRedirect,
  shouldEmitAuthDiagnostics,
  shouldUseSecureCookie,
} from '@/src/server/pilot/microsoftOAuthFlow';
import {
  buildAuthorizeUrl,
  createCodeChallenge,
  createCodeVerifier,
  createNonce,
  createState,
  fetchOidcDiscovery,
  getMsOidcConfig,
} from '@/src/server/pilot/federatedAuth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const config = getMsOidcConfig();
    const canonicalStartRedirect = resolveCanonicalAuthStartRedirect({
      requestUrl: request.url,
      callbackUrl: config.callbackUrl,
      startPathname: request.nextUrl.pathname,
    });

    if (canonicalStartRedirect) {
      if (shouldEmitAuthDiagnostics()) {
        console.info('auth.microsoft.start.canonical_redirect', {
          route: request.nextUrl.pathname,
          requestHost: request.nextUrl.host,
          requestProtocol: request.nextUrl.protocol,
          targetHost: new URL(canonicalStartRedirect).host,
        });
      }

      return NextResponse.redirect(canonicalStartRedirect);
    }

    const discovery = await fetchOidcDiscovery(config.tenantId);
    const state = createState();
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const nonce = createNonce();
    const issuedAtEpochSeconds = Math.floor(Date.now() / 1000);
    const authorizeUrl = buildAuthorizeUrl(discovery, config, state, codeChallenge, nonce);

    const response = NextResponse.redirect(authorizeUrl);
    const secure = shouldUseSecureCookie({
      nextUrlProtocol: request.nextUrl.protocol,
      forwardedProtoHeader: request.headers.get('x-forwarded-proto'),
      nodeEnv: process.env.NODE_ENV,
    });

    response.cookies.set({
      name: MICROSOFT_AUTH_STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    response.cookies.set({
      name: MICROSOFT_AUTH_VERIFIER_COOKIE,
      value: codeVerifier,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    response.cookies.set({
      name: MICROSOFT_AUTH_NONCE_COOKIE,
      value: nonce,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    response.cookies.set({
      name: MICROSOFT_AUTH_ISSUED_AT_COOKIE,
      value: String(issuedAtEpochSeconds),
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    response.cookies.set({
      name: MICROSOFT_AUTH_USED_STATE_COOKIE,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 0,
    });

    if (shouldEmitAuthDiagnostics()) {
      console.info('auth.microsoft.start.issue_state', {
        route: request.nextUrl.pathname,
        host: request.nextUrl.host,
        protocol: request.nextUrl.protocol,
        forwardedProto: request.headers.get('x-forwarded-proto') || 'none',
        stateLength: state.length,
        stateFingerprint: fingerprintValue(state),
        nonceLength: nonce.length,
        verifierLength: codeVerifier.length,
      });
    }

    return response;
  } catch (error) {
    return jsonError(error, 500);
  }
}
