import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { graphTokenProvider } from './managedIdentityToken';
import { sendPlainTextMail } from './graphMailer';
import {
  validateTokenForRedemption,
  type ConsumeFailure,
  type MagicLinkAccount,
  type MagicLinkDependencies,
  type RedeemableTokenRow,
} from './magicLink';
import { createOpaqueToken, hashToken } from './security';
import { computeSessionExpiry } from './sessionPolicy';

/**
 * Binds magicLink.ts to the database, the clock and Microsoft Graph.
 *
 * magicLink.ts holds the decisions and is tested with everything injected.
 * This file holds the queries and the wiring, and nothing else -- keeping the
 * split means the rules stay testable without a database, and the SQL stays
 * readable without the rules tangled through it.
 */

const SENDER = 'Admin@punxsyprominence.org';

function appOrigin(): string {
  const configured = process.env.PPBF_APP_ORIGIN?.trim();
  if (!configured) {
    // A link built against the wrong origin points a parent at a host that
    // cannot redeem it. Better to refuse to send than to send a dead link.
    throw new Error('MISSING_PPBF_APP_ORIGIN');
  }
  return configured;
}

export function magicLinkDependencies(): MagicLinkDependencies {
  return {
    findAccountByEmail: async (email) =>
      queryOne<MagicLinkAccount>(
        `select account_id, organization_id, role, auth_provider, login_email, active_flag
           from pilot.accounts
          where lower(login_email) = lower($1)`,
        [email],
      ),

    invalidateLiveTokens: async (accountId) => {
      await query(
        `update pilot.magic_link_tokens
            set invalidated_at = now()
          where account_id = $1
            and consumed_at is null
            and invalidated_at is null`,
        [accountId],
      );
    },

    storeToken: async (row) => {
      await query(
        `insert into pilot.magic_link_tokens
           (token_hash, account_id, organization_id, sent_to_email, expires_at)
         values ($1, $2, $3, $4, $5)`,
        [row.tokenHash, row.accountId, row.organizationId, row.sentToEmail, row.expiresAt],
      );
    },

    sendMail: async (message) =>
      sendPlainTextMail(message, { sender: SENDER }, {
        getAccessToken: graphTokenProvider(),
        fetchImpl: fetch,
      }),

    now: () => new Date(),
    createToken: createOpaqueToken,
    appOrigin: appOrigin(),
  };
}

export interface RedemptionResult {
  ok: boolean;
  reason?: ConsumeFailure;
  session?: { token: string; expiresAt: Date };
  principal?: { accountId: string; organizationId: string; role: PilotRole };
}

/**
 * Redeems a link and mints a session, in ONE transaction.
 *
 * The first version of this split the work: consumeMagicLink claimed the
 * token, then a separate function created the session. Two bugs came out of
 * that split, and neither would have shown up until a real user clicked a real
 * link:
 *
 *   The claim ran twice. consumeMagicLink set consumed_at, then the session
 *   function tried to claim the same row and found it already consumed, so it
 *   returned null and nobody ever got a session.
 *
 *   Even with one claim, a failure between the two statements leaves a
 *   consumed token with no session -- locking someone out of an account they
 *   just proved they control, with a link that now refuses to work again.
 *
 * SELECT ... FOR UPDATE takes a row lock, so two simultaneous clicks serialise
 * here rather than racing: the second finds consumed_at already set and is
 * refused as TOKEN_ALREADY_USED.
 */
export async function redeemMagicLink(token: string): Promise<RedemptionResult> {
  const tokenHash = hashToken(token);

  return withTransaction(async (client) => {
    const found = await client.query<RedeemableTokenRow>(
      `select t.account_id, t.organization_id, t.sent_to_email, t.expires_at,
              t.consumed_at, t.invalidated_at,
              a.role, a.active_flag, a.login_email
         from pilot.magic_link_tokens t
         join pilot.accounts a on a.account_id = t.account_id
        where t.token_hash = $1
          for update of t`,
      [tokenHash],
    );

    const row = found.rows[0];
    if (!row) return { ok: false, reason: 'TOKEN_UNKNOWN' as ConsumeFailure };

    const refusal = validateTokenForRedemption(row, new Date());
    if (refusal) return { ok: false, reason: refusal };

    await client.query(
      `update pilot.magic_link_tokens set consumed_at = now() where token_hash = $1`,
      [tokenHash],
    );

    const sessionToken = createOpaqueToken();
    const expiresAt = computeSessionExpiry();
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
       values ($1, $2, $3, $4)`,
      [hashToken(sessionToken), row.account_id, row.organization_id, expiresAt],
    );

    return {
      ok: true,
      session: { token: sessionToken, expiresAt },
      principal: {
        accountId: row.account_id,
        organizationId: row.organization_id,
        role: row.role,
      },
    };
  });
}
