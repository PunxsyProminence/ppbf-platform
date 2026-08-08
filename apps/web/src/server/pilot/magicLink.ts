import { AuthProvider } from './authProviders';
import type { PilotRole } from './contracts';
import { requiredCredentialFor } from './credentialPolicy';
import { createOpaqueToken, hashToken } from './security';

/**
 * Single-use sign-in links for coaches, staff, volunteers and parents.
 *
 * Pure logic and SQL. The mail transport, the clock and the token generator are
 * injected, so every branch below is testable without Azure, without a network,
 * and without waiting for a token to actually expire.
 *
 * TWO PROPERTIES THIS RESTS ON
 *
 * The link is the credential. Anyone holding it is the user, so it lives for
 * fifteen minutes, works once, and only ever exists in the recipient's inbox --
 * the database stores its hash, exactly as pilot.session_tokens does. A
 * readable token column would let anyone with database read access sign in as
 * any parent, and this repository already runs backups, support queries and
 * retention scripts against that database.
 *
 * Requesting a link tells the requester nothing. An address with no account
 * gets the same answer, in the same shape, as an address with one. Otherwise
 * the endpoint is an oracle for "does this person's family attend this gym",
 * which is exactly the kind of question a youth boxing club should not answer
 * to anonymous callers.
 */

/** Fifteen minutes. Long enough to walk to a laptop, short enough that a
 *  forwarded or logged link is usually already dead. */
export const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;

export interface MagicLinkAccount {
  account_id: string;
  organization_id: string;
  role: PilotRole;
  auth_provider: AuthProvider;
  login_email: string | null;
  active_flag: boolean;
}

export interface MagicLinkDependencies {
  /** Looks up an account by email. Returns null when there is no such account. */
  findAccountByEmail: (email: string) => Promise<MagicLinkAccount | null>;
  /** Invalidates every live token for an account. Called before issuing a new one. */
  invalidateLiveTokens: (accountId: string) => Promise<void>;
  storeToken: (row: {
    tokenHash: string;
    accountId: string;
    organizationId: string;
    sentToEmail: string;
    expiresAt: Date;
  }) => Promise<void>;
  sendMail: (message: { to: string; subject: string; body: string }) => Promise<void>;
  now: () => Date;
  createToken: () => string;
  /** Absolute base for the link, e.g. https://app.example.org */
  appOrigin: string;
}

export interface ConsumeDependencies {
  /** Loads a token row by hash, with the account joined. Null when absent. */
  loadTokenByHash: (tokenHash: string) => Promise<{
    account_id: string;
    organization_id: string;
    sent_to_email: string;
    expires_at: Date;
    consumed_at: Date | null;
    invalidated_at: Date | null;
    role: PilotRole;
    auth_provider: AuthProvider;
    active_flag: boolean;
    login_email: string | null;
  } | null>;
  markConsumed: (tokenHash: string) => Promise<boolean>;
  now: () => Date;
}

export type ConsumeFailure =
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_INVALIDATED'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_NOT_MAGIC_LINK'
  | 'EMAIL_CHANGED'
  | 'TOKEN_RACE_LOST';

export interface ConsumeSuccess {
  ok: true;
  accountId: string;
  organizationId: string;
  role: PilotRole;
}

export interface ConsumeRejected {
  ok: false;
  reason: ConsumeFailure;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Issues a link, if the address belongs to an account that signs in this way.
 *
 * Returns nothing in every case. The caller answers the HTTP request
 * identically whether a link was sent or not -- see the note above about
 * enumeration. Genuine faults (the mail transport failing) still throw, because
 * those are the caller's problem and not a signal about the address.
 */
export async function issueMagicLink(
  rawEmail: string,
  dependencies: MagicLinkDependencies,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const account = await dependencies.findAccountByEmail(email);

  // Every one of these is a silent no-op, deliberately. An attacker probing
  // addresses learns the same thing from all of them: nothing.
  if (!account) return;
  if (!account.active_flag) return;
  if (requiredCredentialFor({ role: account.role }) !== 'magic_link') return;
  if (!account.login_email || normalizeEmail(account.login_email) !== email) return;

  // Issuing a new link kills the old one. Otherwise a parent who requests three
  // links because the first was slow leaves three working credentials in an
  // inbox, and the two they never used stay valid for fifteen minutes.
  await dependencies.invalidateLiveTokens(account.account_id);

  const token = dependencies.createToken();
  const expiresAt = new Date(dependencies.now().getTime() + MAGIC_LINK_LIFETIME_MS);

  await dependencies.storeToken({
    tokenHash: hashToken(token),
    accountId: account.account_id,
    organizationId: account.organization_id,
    // The address as sent, not the account's current one. If the account email
    // changes while this link is in flight, consumption must refuse rather than
    // hand the new address a session.
    sentToEmail: email,
    expiresAt,
  });

  const link = `${dependencies.appOrigin.replace(/\/+$/, '')}/auth/link?token=${encodeURIComponent(token)}`;

  await dependencies.sendMail({
    to: email,
    subject: 'Your PPBF sign-in link',
    body: [
      'Someone asked to sign in to Punxsy Prominence Boxing and Fitness with this address.',
      '',
      link,
      '',
      'The link works once and expires in 15 minutes.',
      '',
      'If this was not you, you can ignore this message. Nobody can sign in without the link above.',
    ].join('\n'),
  });
}

/** Generates a token without issuing one. Exposed for callers that need the
 *  same generator; the default is a 32-byte opaque token. */
export function newMagicLinkToken(): string {
  return createOpaqueToken();
}

/**
 * Redeems a link. Every refusal is named, because the caller needs to tell an
 * expired link apart from a used one when deciding what to show a human -- and
 * because "it didn't work" is the worst possible message for someone who has
 * been trying to see their kid's schedule for ten minutes.
 */
export async function consumeMagicLink(
  token: string,
  dependencies: ConsumeDependencies,
): Promise<ConsumeSuccess | ConsumeRejected> {
  // Lookup is by hash and the hash is the primary key, so there is no
  // comparison to make timing-safe: an unknown token simply finds no row.
  const row = await dependencies.loadTokenByHash(hashToken(token));
  if (!row) return { ok: false, reason: 'TOKEN_UNKNOWN' };

  if (row.invalidated_at) return { ok: false, reason: 'TOKEN_INVALIDATED' };
  if (row.consumed_at) return { ok: false, reason: 'TOKEN_ALREADY_USED' };
  if (row.expires_at.getTime() <= dependencies.now().getTime()) {
    return { ok: false, reason: 'TOKEN_EXPIRED' };
  }

  // Re-checked at redemption, not trusted from issuance. A coach deactivated
  // in the fifteen minutes since the link was sent must not get in.
  if (!row.active_flag) return { ok: false, reason: 'ACCOUNT_INACTIVE' };
  if (requiredCredentialFor({ role: row.role }) !== 'magic_link') {
    return { ok: false, reason: 'ACCOUNT_NOT_MAGIC_LINK' };
  }

  // The address moved while the link was in flight. The person holding it
  // proved control of the OLD inbox, which is no longer this account's.
  if (!row.login_email || normalizeEmail(row.login_email) !== normalizeEmail(row.sent_to_email)) {
    return { ok: false, reason: 'EMAIL_CHANGED' };
  }

  // Conditional write. markConsumed updates only where consumed_at is still
  // null and returns whether it changed a row, so two simultaneous clicks on
  // the same link produce exactly one session -- the check above is advisory,
  // this is the one that decides.
  const claimed = await dependencies.markConsumed(hashToken(token));
  if (!claimed) return { ok: false, reason: 'TOKEN_RACE_LOST' };

  return {
    ok: true,
    accountId: row.account_id,
    organizationId: row.organization_id,
    role: row.role,
  };
}
