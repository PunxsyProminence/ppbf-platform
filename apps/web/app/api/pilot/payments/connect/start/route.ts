import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  buildAuthorizeUrl,
  readPaymentPlatformConfig,
  signConnectState,
} from '@/src/server/pilot/paymentConnect';

export const runtime = 'nodejs';

// "Connecting an account is a button, not a copy-paste"
// (docs/PAYMENT_SERVICE_SLOT.md). This is the button's other half: it sends
// the admin to Stripe-hosted onboarding for the requested lane and carries a
// signed state so the callback can prove this organization asked for it.
// Admin-only in both directions -- connecting a settlement account is the
// most consequential configuration an organization has.
const CONNECT_ROLES = ['organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CONNECT_ROLES]);

    const lane = request.nextUrl.searchParams.get('lane');
    if (lane !== 'giving' && lane !== 'program') {
      throw new ValidationError("lane must be 'giving' or 'program'.");
    }

    const config = readPaymentPlatformConfig();
    if (!config.connectClientId || !config.platformSecretKey) {
      // Honest, not broken: the platform account has not been registered yet.
      return NextResponse.json(
        {
          ok: false,
          error: 'The platform Stripe account is not registered yet. The connect button lights up once PAYMENT_CONNECT_CLIENT_ID and PAYMENT_PLATFORM_SECRET_KEY exist.',
        },
        { status: 503 },
      );
    }

    const state = signConnectState(
      { organizationId: principal.organizationId, lane },
      config.platformSecretKey,
    );
    const redirectUri = `${request.nextUrl.origin}/api/pilot/payments/connect/callback`;

    return NextResponse.redirect(
      buildAuthorizeUrl({ connectClientId: config.connectClientId, state, redirectUri }),
      { status: 302 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
