import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  CONNECT_NONCE_COOKIE,
  CONNECT_NONCE_COOKIE_PATH,
  connectStateBindsTo,
  exchangeCodeForAccountId,
  readPaymentPlatformConfig,
  upsertConnectedAccount,
  verifyConnectState,
} from '@/src/server/pilot/paymentConnect';

export const runtime = 'nodejs';

// The connect round trip's landing leg: Stripe sends the admin back here
// with a code. The signed state must verify AND bind to the caller: same
// organization, same admin, same session, and the one-time nonce cookie the
// start route set in this browser. A forged, replayed or hand-carried
// redirect cannot attach a Stripe account -- not from another gym, not from
// another admin of this gym, not a second time. The nonce cookie is cleared
// on every response from here, so a state completes at most once.
//
// The exchange happens server-side with the ONE platform secret; the only
// thing stored from it is the connected ACCOUNT ID, as a row.
const CONNECT_ROLES = ['organization_admin', 'admin'] as const;

function settingsRedirect(request: NextRequest, outcome: string, lane?: string): NextResponse {
  const url = new URL('/admin/payments', request.nextUrl.origin);
  url.searchParams.set('connect', outcome);
  if (lane) url.searchParams.set('lane', lane);
  return NextResponse.redirect(url, { status: 302 });
}

// A lost audit row must not stop the redirect: this GET is what Stripe sends
// the admin's browser to directly, a full-page navigation, not a fetch call.
// upsertConnectedAccount already committed the connection by the time this
// runs, so an unguarded throw here previously fell through to jsonError(),
// which always returns NextResponse.json(...) -- never a redirect -- leaving
// the admin looking at raw JSON with no way back to /admin/payments and no
// way to tell the connection actually succeeded.
async function auditConnectionEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'pilot-payments-connect-audit-write-failed',
      ...(code ? { code } : {}),
    });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const response = await handleCallback(request);
  response.cookies.set({
    name: CONNECT_NONCE_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: CONNECT_NONCE_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

async function handleCallback(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CONNECT_ROLES]);

    // The admin said no on Stripe's side, or Stripe refused. Nothing to
    // verify or store; land back on settings with the outcome named.
    if (request.nextUrl.searchParams.get('error')) {
      return settingsRedirect(request, 'denied');
    }

    const config = readPaymentPlatformConfig();
    if (!config.connectClientId || !config.platformSecretKey) {
      return settingsRedirect(request, 'not-configured');
    }

    const state = request.nextUrl.searchParams.get('state') ?? '';
    const claims = verifyConnectState(state, config.platformSecretKey);
    const cookieNonce = request.cookies.get(CONNECT_NONCE_COOKIE)?.value ?? null;
    if (!claims || !connectStateBindsTo(claims, {
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      sessionToken: principal.sessionToken,
      cookieNonce,
    })) {
      return settingsRedirect(request, 'state-mismatch');
    }

    const code = request.nextUrl.searchParams.get('code');
    if (!code) {
      return settingsRedirect(request, 'missing-code');
    }

    const stripeAccountId = await exchangeCodeForAccountId(code, config.platformSecretKey);
    const row = await upsertConnectedAccount({
      organizationId: principal.organizationId,
      lane: claims.lane,
      stripeAccountId,
      connectedByAccountId: principal.accountId,
    });

    await auditConnectionEvent({
      event_type: 'payment_account_connected',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'payment_account',
      entity_id: `${principal.organizationId}:${claims.lane}`,
      details: { lane: claims.lane, stripe_account_id: row.stripe_account_id },
    });

    return settingsRedirect(request, 'ok', claims.lane);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PAYMENT_CONNECT_EXCHANGE_FAILED')) {
      return settingsRedirect(request, 'exchange-failed');
    }
    return jsonError(error);
  }
}
