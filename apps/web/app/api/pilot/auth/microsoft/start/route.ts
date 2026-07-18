import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
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

const STATE_COOKIE = 'ppbf_ms_auth_state';
const VERIFIER_COOKIE = 'ppbf_ms_auth_verifier';
const NONCE_COOKIE = 'ppbf_ms_auth_nonce';

export async function GET(request: NextRequest) {
  try {
    const config = getMsOidcConfig();
    const discovery = await fetchOidcDiscovery(config.tenantId);
    const state = createState();
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const nonce = createNonce();
    const authorizeUrl = buildAuthorizeUrl(discovery, config, state, codeChallenge, nonce);

    const response = NextResponse.redirect(authorizeUrl);
    const secure = request.nextUrl.protocol === 'https:';

    response.cookies.set({
      name: STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    response.cookies.set({
      name: VERIFIER_COOKIE,
      value: codeVerifier,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    response.cookies.set({
      name: NONCE_COOKIE,
      value: nonce,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 10 * 60,
    });

    return response;
  } catch (error) {
    return jsonError(error, 500);
  }
}
