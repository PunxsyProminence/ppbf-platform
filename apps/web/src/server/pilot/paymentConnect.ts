import { createHmac, timingSafeEqual } from 'node:crypto';

import { query, queryOne } from './db';
import type { PaymentLane } from './paymentSetup';

// The Stripe Connect flow (docs/PAYMENT_SERVICE_SLOT.md): an admin presses
// "Connect Stripe account", completes Stripe-hosted onboarding, and the
// platform stores the returned ACCOUNT ID as a row in pilot.payment_accounts.
// No secret key ever passes through anyone's clipboard: the platform holds
// ONE credential set (env vars below), and connected accounts are rows.
// Adding a gym must never mean adding a secret.
//
// Nothing in this module moves money. Charging does not exist anywhere in
// this repository, and CAP-012 stays BLOCKED until the owner's compliance
// sign-off. What this module enables is exactly onboarding and revocation.

const STRIPE_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize';
const STRIPE_TOKEN_URL = 'https://connect.stripe.com/oauth/token';

/** How long a connect attempt's state token stays valid. Long enough to
 * complete Stripe onboarding in one sitting, short enough that a leaked link
 * goes stale. */
const CONNECT_STATE_TTL_SECONDS = 30 * 60;

/** How much clock skew the webhook signature check tolerates. Stripe's own
 * SDK default. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface PaymentPlatformConfig {
  connectClientId: string | null;
  platformSecretKey: string | null;
  webhookSecret: string | null;
}

export function readPaymentPlatformConfig(): PaymentPlatformConfig {
  return {
    connectClientId: process.env.PAYMENT_CONNECT_CLIENT_ID?.trim() || null,
    platformSecretKey: process.env.PAYMENT_PLATFORM_SECRET_KEY?.trim() || null,
    webhookSecret: process.env.PAYMENT_PLATFORM_WEBHOOK_SECRET?.trim() || null,
  };
}

export interface PaymentAccountRow {
  organization_id: string;
  lane: PaymentLane;
  stripe_account_id: string;
  status: 'connected' | 'disconnected';
  connected_by_account_id: string;
  connected_at: string;
  revoked_at: string | null;
}

const ACCOUNT_FIELDS = `organization_id, lane, stripe_account_id, status,
  connected_by_account_id, connected_at, revoked_at`;

// ---------------------------------------------------------------------------
// OAuth state: an HMAC-signed claim that THIS org's admin started THIS
// lane's connect attempt, with an expiry. Verified on the callback so a
// forged or replayed redirect cannot attach a Stripe account to an
// organization that never asked for it.
// ---------------------------------------------------------------------------

interface ConnectStateClaims {
  organizationId: string;
  lane: PaymentLane;
  expiresAtEpochSeconds: number;
}

function stateSignature(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function signConnectState(
  claims: { organizationId: string; lane: PaymentLane },
  signingKey: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = Buffer.from(JSON.stringify({
    organizationId: claims.organizationId,
    lane: claims.lane,
    expiresAtEpochSeconds: nowEpochSeconds + CONNECT_STATE_TTL_SECONDS,
  } satisfies ConnectStateClaims)).toString('base64url');
  return `${payload}.${stateSignature(payload, signingKey)}`;
}

export function verifyConnectState(
  state: string,
  signingKey: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): ConnectStateClaims | null {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  const expected = stateSignature(payload, signingKey);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  let claims: ConnectStateClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConnectStateClaims;
  } catch {
    return null;
  }
  if (typeof claims.organizationId !== 'string' || !claims.organizationId) return null;
  if (claims.lane !== 'giving' && claims.lane !== 'program') return null;
  if (typeof claims.expiresAtEpochSeconds !== 'number' || claims.expiresAtEpochSeconds < nowEpochSeconds) {
    return null;
  }
  return claims;
}

export function buildAuthorizeUrl(input: {
  connectClientId: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL(STRIPE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.connectClientId);
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('state', input.state);
  url.searchParams.set('redirect_uri', input.redirectUri);
  return url.toString();
}

/** Exchange the OAuth code for the connected account id. The platform secret
 * authenticates the exchange server-side; nothing is stored from the response
 * except the account id -- tokens for acting on connected accounts come from
 * the platform key at call time, per Stripe Connect's model. */
export async function exchangeCodeForAccountId(code: string, platformSecretKey: string): Promise<string> {
  const response = await fetch(STRIPE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_secret: platformSecretKey,
    }).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as { stripe_user_id?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.stripe_user_id) {
    // The description is Stripe's own wording about OUR request (bad code,
    // revoked client); it carries no card or account data.
    throw new Error(`PAYMENT_CONNECT_EXCHANGE_FAILED: ${payload.error ?? response.status}${payload.error_description ? ` (${payload.error_description})` : ''}`);
  }
  return payload.stripe_user_id;
}

// ---------------------------------------------------------------------------
// pilot.payment_accounts: the connect flow's whole state.
// ---------------------------------------------------------------------------

/** Reconnecting a lane is an UPDATE to its one row -- the primary key
 * (organization_id, lane) is what makes "swap accounts in and out" safe:
 * there is never a moment with two giving accounts and an ambiguous
 * destination. */
export async function upsertConnectedAccount(input: {
  organizationId: string;
  lane: PaymentLane;
  stripeAccountId: string;
  connectedByAccountId: string;
}): Promise<PaymentAccountRow> {
  const row = await queryOne<PaymentAccountRow>(
    `insert into pilot.payment_accounts
       (organization_id, lane, stripe_account_id, status, connected_by_account_id)
     values ($1, $2, $3, 'connected', $4)
     on conflict (organization_id, lane) do update set
       stripe_account_id = excluded.stripe_account_id,
       status = 'connected',
       connected_by_account_id = excluded.connected_by_account_id,
       connected_at = now(),
       revoked_at = null,
       updated_at = now()
     returning ${ACCOUNT_FIELDS}`,
    [input.organizationId, input.lane, input.stripeAccountId, input.connectedByAccountId],
  );
  if (!row) throw new Error('Unable to store the connected account.');
  return row;
}

export async function listPaymentAccounts(organizationId: string): Promise<PaymentAccountRow[]> {
  return query<PaymentAccountRow>(
    `select ${ACCOUNT_FIELDS} from pilot.payment_accounts
     where organization_id = $1
     order by lane asc`,
    [organizationId],
  );
}

/** The lanes that can currently settle money, for the setup checklist. */
export async function getConnectedLanes(organizationId: string): Promise<PaymentLane[]> {
  const rows = await query<{ lane: PaymentLane }>(
    `select lane from pilot.payment_accounts
     where organization_id = $1 and status = 'connected'`,
    [organizationId],
  );
  return rows.map((row) => row.lane);
}

/** Deauthorization: Stripe says the gym disconnected from its own dashboard.
 * Mark every lane that account backed as disconnected -- an integration that
 * only handles connection is one that keeps trying to charge through a
 * revoked account. Returns the affected rows so the caller can audit each. */
export async function markAccountDisconnected(stripeAccountId: string): Promise<PaymentAccountRow[]> {
  return query<PaymentAccountRow>(
    `update pilot.payment_accounts
     set status = 'disconnected', revoked_at = now(), updated_at = now()
     where stripe_account_id = $1 and status = 'connected'
     returning ${ACCOUNT_FIELDS}`,
    [stripeAccountId],
  );
}

// ---------------------------------------------------------------------------
// Webhook signature (Stripe's t=...,v1=... scheme): HMAC-SHA256 of
// "<timestamp>.<raw body>" with the endpoint secret, plus a freshness window
// so a captured payload cannot be replayed later.
// ---------------------------------------------------------------------------

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;

  let timestamp: string | null = null;
  const candidateSignatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') candidateSignatures.push(value);
  }
  if (!timestamp || candidateSignatures.length === 0) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(nowEpochSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  return candidateSignatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate);
    return candidateBuffer.length === expectedBuffer.length
      && timingSafeEqual(candidateBuffer, expectedBuffer);
  });
}
