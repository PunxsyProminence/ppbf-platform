import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  markAccountDisconnected,
  readPaymentPlatformConfig,
  verifyStripeWebhookSignature,
} from '@/src/server/pilot/paymentConnect';

export const runtime = 'nodejs';

// The ONE webhook endpoint (docs/PAYMENT_SERVICE_SLOT.md). Safe as a single
// endpoint precisely because every event is signed with the one platform
// secret and names its account in the event itself; the lane is resolved by
// looking that account up in pilot.payment_accounts -- never inferred from
// the payload. An event naming an account the platform does not have on file
// is rejected, not guessed at.
//
// v1 handles exactly one event family: revocation.
// account.application.deauthorized means the gym disconnected from its own
// Stripe dashboard; the row is marked disconnected so nothing ever tries to
// charge through a revoked account. Mirror-table writes (transactions,
// subscriptions) arrive with the checkout slice, behind the owner's
// compliance sign-off -- until then every other event type is acknowledged
// and deliberately ignored.

export async function POST(request: NextRequest) {
  const config = readPaymentPlatformConfig();
  if (!config.webhookSecret) {
    return NextResponse.json(
      { ok: false, error: 'Webhook secret not configured.' },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signatureValid = verifyStripeWebhookSignature(
    rawBody,
    request.headers.get('stripe-signature'),
    config.webhookSecret,
  );
  if (!signatureValid) {
    return NextResponse.json({ ok: false, error: 'Invalid signature.' }, { status: 400 });
  }

  let event: { type?: string; account?: string };
  try {
    event = JSON.parse(rawBody) as { type?: string; account?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed payload.' }, { status: 400 });
  }

  if (event.type !== 'account.application.deauthorized') {
    // Acknowledged, deliberately unhandled: nothing charges yet, so there is
    // nothing to mirror. Returning 200 keeps Stripe from retrying forever.
    return NextResponse.json({ received: true, handled: false });
  }

  const stripeAccountId = typeof event.account === 'string' ? event.account.trim() : '';
  if (!stripeAccountId) {
    return NextResponse.json({ ok: false, error: 'Deauthorization event without an account.' }, { status: 400 });
  }

  const affected = await markAccountDisconnected(stripeAccountId);
  if (affected.length === 0) {
    // Not on file (or already disconnected): rejected, not guessed at.
    return NextResponse.json({ ok: false, error: 'Account not on file.' }, { status: 400 });
  }

  for (const row of affected) {
    await writePilotAuditEvent({
      event_type: 'payment_account_disconnected',
      actor_account_id: null,
      actor_role: null,
      organization_id: row.organization_id,
      entity_type: 'payment_account',
      entity_id: `${row.organization_id}:${row.lane}`,
      details: { lane: row.lane, stripe_account_id: row.stripe_account_id, source: 'stripe_deauthorization_webhook' },
    });
  }

  return NextResponse.json({ received: true, handled: true, lanes_disconnected: affected.length });
}
