// Mints a short-lived session for a pre-provisioned gate fixture account by
// writing directly to pilot.session_tokens, the same table a normal sign-in
// writes to.
//
// Why this exists: the deploy gates used to sign in with an account id and a
// PIN. That cannot work for any privileged fixture. PIN sessions are athlete
// self-service only -- loginWithAccountIdAndPin returns null for every role
// except 'athlete' -- and the bootstrap endpoint that used to create those
// accounts now refuses every request, so the gates could never authenticate as
// an administrator or a guardian and had no way to pass.
//
// The alternative would have been a privileged non-interactive auth endpoint,
// which is new attack surface in production code for a CI convenience. This
// adds no application code path at all: CI already holds Azure rights over the
// deployment, so reading the connection string and writing one session row is
// not an escalation, and the row is revoked when the gate finishes.
//
// This deliberately provisions NOTHING. It verifies that a fixture account is
// already in the state the gate needs and refuses otherwise, so a
// misconfigured environment produces a precise error instead of a gate that
// silently invents its own fixtures.

import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';

export const SESSION_COOKIE_NAME = 'ppbf_pilot_session';

// Far below the 24h absolute session lifetime in sessionPolicy.ts. A gate run
// is minutes; anything longer is a credential left lying around.
const DEFAULT_TTL_MINUTES = 30;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function connect(connectionString) {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

/**
 * Mints a session for an existing fixture account.
 *
 * Returns { token, cookie, organizationId, revoke() }. Always call revoke() --
 * a `finally` block is the right place -- so a failed gate does not leave a
 * live session behind.
 */
export async function mintGateSession({
  connectionString,
  accountId,
  expectedRole,
  ttlMinutes = DEFAULT_TTL_MINUTES,
}) {
  if (!connectionString?.trim()) {
    throw new Error('mintGateSession requires a connection string');
  }
  if (!accountId?.trim()) {
    throw new Error('mintGateSession requires an account id');
  }

  const client = await connect(connectionString);

  try {
    const { rows } = await client.query(
      `select
         a.account_id,
         a.role,
         a.organization_id,
         a.auth_provider,
         a.active_flag,
         o.status as organization_status,
         exists (
           select 1
           from pilot.organization_memberships om
           where om.account_id = a.account_id
             and om.organization_id = a.organization_id
             and om.active_flag = true
         ) as has_membership
       from pilot.accounts a
       left join pilot.organizations o on o.organization_id = a.organization_id
       where a.account_id = $1`,
      [accountId],
    );

    const account = rows[0];
    if (!account) {
      throw new Error(
        `Gate fixture account "${accountId}" does not exist. Provision it through the normal `
        + `administration flow before running this gate; the gate does not create accounts.`,
      );
    }

    if (expectedRole && account.role !== expectedRole) {
      throw new Error(
        `Gate fixture account "${accountId}" has role "${account.role}", expected "${expectedRole}".`,
      );
    }

    if (!account.active_flag) {
      throw new Error(`Gate fixture account "${accountId}" is inactive.`);
    }

    // resolvePrincipal joins organization_memberships, so an account without an
    // active membership resolves to null and every call 401s -- with nothing to
    // indicate the membership is what is missing.
    if (!account.has_membership) {
      throw new Error(
        `Gate fixture account "${accountId}" has no active membership in "${account.organization_id}". `
        + `Session resolution requires one, so every request would answer 401.`,
      );
    }

    if (account.organization_status && account.organization_status !== 'active') {
      throw new Error(
        `Organization "${account.organization_id}" is "${account.organization_status}", not active.`,
      );
    }

    // resolvePrincipal fails closed on any live session whose account is
    // ppbf_local and not an athlete -- it revokes the row on sight. A session
    // minted for such an account would be destroyed by its own first use, so
    // refuse here where the reason can be stated.
    if (account.auth_provider === 'ppbf_local' && account.role !== 'athlete') {
      throw new Error(
        `Gate fixture account "${accountId}" is a local (PIN) account with role "${account.role}". `
        + `Privileged local sessions are revoked on first use by design, so this account cannot be `
        + `used by the gate. It must be Microsoft-authenticated.`,
      );
    }

    const token = randomBytes(32).toString('hex');
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
       values ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [hashToken(token), account.account_id, account.organization_id, String(ttlMinutes)],
    );

    return {
      token,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      organizationId: account.organization_id,
      role: account.role,
      async revoke() {
        const revokeClient = await connect(connectionString);
        try {
          await revokeClient.query(
            'update pilot.session_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null',
            [hashToken(token)],
          );
        } finally {
          await revokeClient.end();
        }
      },
    };
  } finally {
    await client.end();
  }
}
