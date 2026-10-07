import { AuthProvider } from './authProviders';
import type { PilotRole } from './contracts';
import { requiredCredentialFor } from './credentialPolicy';
import { isDeletedAccount, type AccountDeletionFlag } from './deletedAccountSignIn';
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

export interface MagicLinkAccount extends AccountDeletionFlag {
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
  /**
   * Invalidates every live token for an account issued BEFORE the one named
   * (never the named one, never a newer one). Called after the new link has
   * been sent, so the link the person already holds outlives a send that
   * fails, and two overlapping requests cannot retire each other (see
   * issueMagicLink).
   */
  invalidateLiveTokens: (accountId: string, keepTokenHash: string) => Promise<void>;
  /** Invalidates one token by hash: the new link, when its send failed. */
  discardToken: (tokenHash: string) => Promise<void>;
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
  /** Absolute base for the link, e.g. https://app.example.org -- see magicLinkOrigin. */
  appOrigin: string;
}

/**
 * The site address a sign-in link may be built on, or a throw.
 *
 * On 2026-10-06 production's PPBF_APP_ORIGIN was `punxsyprominence.org`: no
 * scheme, and a host with no address record. Every emailed link was dead,
 * every send reported success, and nobody knew until a parent said so. The
 * value had passed the only check there was, "not empty".
 *
 * So the shape is checked, not the presence: an absolute https URL with a
 * host and nothing after it. `http:` is admitted only for the loopback hosts
 * db.ts admits for a local Postgres (localhost, 127.0.0.0/8, ::1), which is
 * where a development server runs and the only place the code allows it.
 *
 * The thrown message names the reason and never the value: it reaches logs.
 */
export function magicLinkOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('INVALID_PPBF_APP_ORIGIN:empty');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('INVALID_PPBF_APP_ORIGIN:not_absolute_url');
  }

  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!host) throw new Error('INVALID_PPBF_APP_ORIGIN:no_host');
  // A trailing dot is a different host to a browser's cookie jar: the link
  // would open, and the session cookie would not stick.
  if (host.endsWith('.')) throw new Error('INVALID_PPBF_APP_ORIGIN:trailing_dot_host');

  if (url.protocol === 'http:') {
    if (!isLoopbackHost(host)) throw new Error('INVALID_PPBF_APP_ORIGIN:http_not_loopback');
  } else if (url.protocol !== 'https:') {
    throw new Error('INVALID_PPBF_APP_ORIGIN:not_https');
  }

  if (url.username || url.password) throw new Error('INVALID_PPBF_APP_ORIGIN:credentials');
  if (url.search || url.hash) throw new Error('INVALID_PPBF_APP_ORIGIN:query_or_fragment');
  // `new URL('https://x')` reports pathname '/', so the bare origin and a
  // single trailing slash both pass; anything deeper is a path.
  if (url.pathname !== '/') throw new Error('INVALID_PPBF_APP_ORIGIN:has_path');

  return url.origin;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const parts = host.split('.');
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
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
    account_deleted: boolean;
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
  // Checked before the lookup, so a bad site address fails for every
  // address alike: nothing stored, nothing mailed, and no difference between
  // an address with an account and one without.
  const origin = magicLinkOrigin(dependencies.appOrigin);

  const email = normalizeEmail(rawEmail);
  const account = await dependencies.findAccountByEmail(email);

  // Every one of these is a silent no-op, deliberately. An attacker probing
  // addresses learns the same thing from all of them: nothing.
  if (!account) return;
  // A deleted person is sent nothing, even when an admin path has set the
  // account active again (deletedAccountSignIn.ts).
  if (isDeletedAccount(account)) return;
  if (!account.active_flag) return;
  if (requiredCredentialFor({ role: account.role }) !== 'magic_link') return;
  if (!account.login_email || normalizeEmail(account.login_email) !== email) return;

  const token = dependencies.createToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(dependencies.now().getTime() + MAGIC_LINK_LIFETIME_MS);

  await dependencies.storeToken({
    tokenHash,
    accountId: account.account_id,
    organizationId: account.organization_id,
    // The address as sent, not the account's current one. If the account email
    // changes while this link is in flight, consumption must refuse rather than
    // hand the new address a session.
    sentToEmail: email,
    expiresAt,
  });

  const link = `${origin}/auth/link?token=${encodeURIComponent(token)}`;

  // THE OLD LINK OUTLIVES A FAILED SEND. This used to invalidate the account's
  // live links first, then store, then send -- so a send that failed left the
  // person with no working link at all, including the one still unread in
  // their inbox, while the page told them a new one was coming.
  //
  // The rule now: store the new link; send it; only on a successful send
  // invalidate every live link for the account issued BEFORE this one. A
  // failed send discards the new link (not known to have been delivered) and
  // leaves the old one untouched, then rethrows so the caller sees the fault.
  //
  // "Before this one", not "every other one": two overlapping requests -- a
  // phone and the gym tablet, or a reload while the first is slow -- that
  // each retired everything but their own would retire each other, leaving
  // two emails and no working link. Retiring only older links means the
  // newest always survives, whichever send finishes first.
  //
  // Two links are valid together only while a send is in flight. Should the
  // process die between the send and the invalidation, both stay valid, each
  // until its own fifteen-minute expiry and no longer: the expiry rule above
  // is the ceiling, as it always was. Serial requests still end with one live
  // link per account, so a parent who requests three links because the first
  // was slow is not left with three working credentials in an inbox.
  try {
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
  } catch (sendError) {
    // Best effort: a link not known to have been delivered is discarded, and
    // a failure to discard it changes nothing about who can sign in. The send
    // fault is the one to report.
    await dependencies.discardToken(tokenHash).catch(() => undefined);
    throw sendError;
  }

  try {
    await dependencies.invalidateLiveTokens(account.account_id, tokenHash);
  } catch (retireError) {
    // The link went out, so this is not a failed issue and must not be
    // reported as one. The cost is the older link staying valid until its own
    // expiry -- inside the ceiling above. Shape only; this line reaches logs.
    console.error(JSON.stringify({
      event: 'magic_link.retire_older_failed',
      error_type: retireError instanceof Error ? retireError.name : typeof retireError,
      error_code: retireError instanceof Error ? retireError.message : 'unknown',
    }));
  }
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
/** The token row's shape, as both the validator and the store see it. */
export interface RedeemableTokenRow extends AccountDeletionFlag {
  account_id: string;
  organization_id: string;
  sent_to_email: string;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  role: PilotRole;
  active_flag: boolean;
  login_email: string | null;
}

/**
 * Every reason a link may be refused, as a pure function of the row and the
 * time. Returns null when the link is good.
 *
 * Separated so the store can run exactly these checks inside the same
 * transaction that claims the token and mints the session. Claiming in one
 * statement and creating the session in another leaves two ways to fail: a
 * consumed token with no session locks someone out of an account they just
 * proved they control, and a session with an unconsumed token leaves the link
 * reusable.
 */
export function validateTokenForRedemption(
  row: RedeemableTokenRow,
  now: Date,
): ConsumeFailure | null {
  if (row.invalidated_at) return 'TOKEN_INVALIDATED';
  if (row.consumed_at) return 'TOKEN_ALREADY_USED';
  if (row.expires_at.getTime() <= now.getTime()) return 'TOKEN_EXPIRED';

  // Re-checked at redemption, not trusted from issuance. A coach deactivated
  // in the fifteen minutes since the link was sent must not get in.
  //
  // A deleted account is refused under the same code, so the link page shows
  // its existing "not active" message. It needs its own check because an
  // admin path can set a deleted account active again (deletedAccountSignIn.ts).
  if (isDeletedAccount(row)) return 'ACCOUNT_INACTIVE';
  if (!row.active_flag) return 'ACCOUNT_INACTIVE';
  if (requiredCredentialFor({ role: row.role }) !== 'magic_link') {
    return 'ACCOUNT_NOT_MAGIC_LINK';
  }

  // The address moved while the link was in flight. The person holding it
  // proved control of the OLD inbox, which is no longer this account's.
  if (!row.login_email || normalizeEmail(row.login_email) !== normalizeEmail(row.sent_to_email)) {
    return 'EMAIL_CHANGED';
  }

  return null;
}

export async function consumeMagicLink(
  token: string,
  dependencies: ConsumeDependencies,
): Promise<ConsumeSuccess | ConsumeRejected> {
  // Lookup is by hash and the hash is the primary key, so there is no
  // comparison to make timing-safe: an unknown token simply finds no row.
  const row = await dependencies.loadTokenByHash(hashToken(token));
  if (!row) return { ok: false, reason: 'TOKEN_UNKNOWN' };

  const refusal = validateTokenForRedemption(row, dependencies.now());
  if (refusal) return { ok: false, reason: refusal };

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
