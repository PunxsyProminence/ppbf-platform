import type { NextRequest } from 'next/server';
import type { PoolClient } from 'pg';

import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

import { seedDefaultComplianceRules } from './complianceRuleSeeds';
import type { AuthProvider } from './authProviders';
import type { PilotRole } from './contracts';
import { usesPin } from './credentialPolicy';
import { getPilotDefaultOrganizationId, PILOT_SESSION_COOKIE } from './env';
import { isPlatformLibraryOrganization } from './platformLibraryScope';
import { seedDefaultSafetyGates } from './safetyGateSeeds';
import { createOpaqueToken, hashPin, hashToken, verifyPin } from './security';
import { computeSessionExpiry, parseRetentionDays } from './sessionPolicy';
import { query, queryOne, withTransaction } from './db';
import { DEFAULT_FIRST_LOGIN_PIN, assertChosenPinAllowed, validatePinPolicy } from './pinPolicy';

/**
 * The single Microsoft identity permitted to hold platform ownership.
 *
 * Both the sign-in path and the platform-owner bootstrap resolve the owner
 * through here, so the address that bootstrap writes and the address sign-in
 * accepts cannot drift apart.
 */
export function getPrimaryOwnerEmail(): string {
  return (process.env.PPBF_PRIMARY_OWNER_EMAIL?.trim() || 'admin@punxsyprominence.org').toLowerCase();
}

export interface PilotPrincipal {
  accountId: string;
  role: PilotRole;
  organizationId: string;
  athleteId: string | null;
  sessionToken: string;
  authProvider: AuthProvider;
  hasMasterShadowAccess?: boolean;
  /**
   * True while this account is still on the admin-issued bootstrap PIN.
   * requirePrincipal treats it as a hard stop, so callers never have to
   * remember to check it -- see http.ts.
   *
   * Optional only so the many test fixtures that build a principal by hand do
   * not each have to restate it; resolvePrincipal and both login paths always
   * populate it, and the underlying column is `not null default false`.
   */
  mustChangePin?: boolean;
}

interface AccountRow {
  account_id: string;
  role: PilotRole;
  organization_id: string | null;
  is_platform_owner: boolean;
  athlete_id: string | null;
  auth_provider: AuthProvider;
  pin_hash: string | null;
  must_change_pin: boolean;
  active_flag: boolean;
  has_master_shadow_access: boolean;
  organization_status: string | null;
}

interface FederatedAccountRow {
  account_id: string;
  role: PilotRole;
  organization_id: string | null;
  is_platform_owner: boolean;
  athlete_id: string | null;
  auth_provider: AuthProvider;
  active_flag: boolean;
  has_master_shadow_access: boolean;
  organization_status: string | null;
}

async function revokeAllSessionsForAccountTx(client: PoolClient, accountId: string): Promise<void> {
  await client.query(
    'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
    [accountId],
  );
}

async function assignOrganizationMembershipTx(
  client: PoolClient,
  accountId: string,
  organizationId: string,
  role: PilotRole,
): Promise<void> {
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)
     on conflict (account_id, organization_id) do update
       set role = excluded.role,
           active_flag = true,
           updated_at = now()`,
    [accountId, organizationId, role],
  );
}

export async function loginWithAccountIdAndPin(accountId: string, pin: string): Promise<{ principal: PilotPrincipal; token: string } | null> {
  const data = await queryOne<AccountRow>(
    `select
       a.account_id,
       a.role,
       a.organization_id,
       a.is_platform_owner,
       a.athlete_id,
       a.auth_provider,
       a.pin_hash,
       a.must_change_pin,
       a.active_flag,
       a.has_master_shadow_access,
       o.status as organization_status
     from pilot.accounts a
     left join pilot.organizations o on o.organization_id = a.organization_id
     where a.account_id = $1
       and a.auth_provider = 'ppbf_local'`,
    [accountId],
  );

  // Every rejection below logs a reason code (never the PIN) before
  // returning null. Nothing else does: the durable rate-limit bucket this
  // route also checks is deleted once it is more than 15 minutes old
  // (rateLimit.ts), so an attacker spacing guesses out, or spreading them
  // across accounts, previously left zero trace anywhere once that window
  // passed -- no forensic trail for a suspected brute-force against a
  // minor's account.
  if (!data?.active_flag) {
    console.warn('pilot-auth login rejected', { accountId, reason: 'unknown_or_inactive_account' });
    return null;
  }

  const organizationId = data.organization_id || getPilotDefaultOrganizationId();
  if (!data.is_platform_owner && data.organization_status && data.organization_status !== 'active') {
    console.warn('pilot-auth login rejected', { accountId, reason: 'organization_not_active' });
    return null;
  }

  if (!data.pin_hash) {
    console.warn('pilot-auth login rejected', { accountId, reason: 'no_pin_set' });
    return null;
  }

  const pinIsValid = await verifyPin(pin, data.pin_hash);
  if (!pinIsValid) {
    console.warn('pilot-auth login rejected', { accountId, reason: 'wrong_pin' });
    return null;
  }

  // PIN sessions are athlete self-service only. Enforce before creating
  // any session token row so privileged local sessions are never minted.
  //
  // Asks credentialPolicy rather than testing the role here. This check and the
  // login page's default tab used to state the rule separately, and the page
  // had it wrong -- it offered a PIN form to everyone.
  if (!usesPin({ role: data.role })) {
    console.warn('pilot-auth login rejected', { accountId, reason: 'role_not_pin_eligible' });
    return null;
  }

  const token = createOpaqueToken();
  const tokenHash = hashToken(token);
  const expiresAt = computeSessionExpiry();

  await query(
    'insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at) values ($1, $2, $3, $4)',
    [tokenHash, data.account_id, organizationId, expiresAt],
  );

  return {
    token,
    principal: {
      accountId: data.account_id,
      role: data.role,
      organizationId,
      athleteId: data.athlete_id,
      sessionToken: token,
      authProvider: data.auth_provider,
      hasMasterShadowAccess: data.has_master_shadow_access,
      mustChangePin: data.must_change_pin,
    },
  };
}

export async function loginWithMicrosoftEmail(emailOrUpn: string): Promise<{ principal: PilotPrincipal; token: string } | null> {
  const normalizedEmail = emailOrUpn.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const data = await queryOne<FederatedAccountRow>(
    `select
       a.account_id,
       a.role,
       a.organization_id,
       a.is_platform_owner,
       a.athlete_id,
       a.auth_provider,
       a.active_flag,
       a.has_master_shadow_access,
       o.status as organization_status
     from pilot.accounts a
     left join pilot.organizations o on o.organization_id = a.organization_id
     where lower(a.login_email) = $1
       and a.auth_provider = 'microsoft'`,
    [normalizedEmail],
  );

  if (!data?.active_flag) {
    return null;
  }

  const organizationId = data.organization_id || getPilotDefaultOrganizationId();
  if (!data.is_platform_owner && data.organization_status && data.organization_status !== 'active') {
    return null;
  }

  // Every reason this sign-in can be refused is decided before a token exists.
  // A refusal that ran after the insert still wrote a pilot.session_tokens row
  // for a session the user was never given.
  if (!getPilotRoleDestination(data.role)) {
    throw new Error('Forbidden: unsupported authenticated role');
  }

  if (data.role === 'platform_owner' && normalizedEmail !== getPrimaryOwnerEmail()) {
    throw new Error('Forbidden: platform owner identity mismatch');
  }

  const token = createOpaqueToken();
  const tokenHash = hashToken(token);
  const expiresAt = computeSessionExpiry();

  await query(
    'insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at) values ($1, $2, $3, $4)',
    [tokenHash, data.account_id, organizationId, expiresAt],
  );

  return {
    token,
    principal: {
      accountId: data.account_id,
      role: data.role,
      organizationId,
      athleteId: data.athlete_id,
      sessionToken: token,
      authProvider: data.auth_provider,
      hasMasterShadowAccess: data.has_master_shadow_access,
      // Microsoft accounts never hold a PIN, so they are never mid-bootstrap.
      mustChangePin: false,
    },
  };
}

export async function resolvePrincipal(request: NextRequest): Promise<PilotPrincipal | null> {
  const token = request.cookies.get(PILOT_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);

  const row = await queryOne<{
    account_id: string;
    role: PilotRole;
    organization_id: string | null;
    is_platform_owner: boolean;
    athlete_id: string | null;
    auth_provider: AuthProvider;
    active_flag: boolean;
    has_master_shadow_access: boolean;
    must_change_pin: boolean;
    organization_status: string | null;
  }>(
    `select
       a.account_id,
       a.role,
       coalesce(st.organization_id, a.organization_id) as organization_id,
       a.is_platform_owner,
       a.athlete_id,
       a.auth_provider,
       a.active_flag,
       a.has_master_shadow_access,
       a.must_change_pin,
       o.status as organization_status
     from pilot.session_tokens st
     join pilot.accounts a on a.account_id = st.account_id
     left join pilot.organizations o on o.organization_id = coalesce(st.organization_id, a.organization_id)
     join pilot.organization_memberships om
       on om.account_id = a.account_id
      and om.organization_id = coalesce(st.organization_id, a.organization_id)
      and om.active_flag = true
     where st.token_hash = $1
       and st.revoked_at is null
       and st.expires_at > now()`,
    [tokenHash],
  );

  if (!row?.active_flag) {
    return null;
  }

  // Fail closed: legacy or pre-deployment privileged local sessions are not
  // valid under athlete-only PIN policy. Revoke the session row immediately
  // so subsequent checks also fail without re-evaluating this branch.
  //
  // This is what made the 19 abandoned platform-owner accounts found in
  // production on 2026-08-07 inert rather than exploitable: every one was
  // ppbf_local with a non-athlete role, so no session they held could survive
  // this branch.
  if (row.auth_provider === 'ppbf_local' && !usesPin({ role: row.role })) {
    await query(
      'update pilot.session_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null',
      [tokenHash],
    );
    return null;
  }

  const organizationId = row.organization_id || getPilotDefaultOrganizationId();
  if (!row.is_platform_owner && row.organization_status && row.organization_status !== 'active') {
    return null;
  }

  return {
    accountId: row.account_id,
    role: row.role,
    organizationId,
    athleteId: row.athlete_id,
    sessionToken: token,
    authProvider: row.auth_provider,
    hasMasterShadowAccess: row.has_master_shadow_access,
    mustChangePin: row.must_change_pin,
  };
}

export async function logoutWithToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);

  await query('update pilot.session_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [tokenHash]);
}

// Used by organization-admin-triggered revocation. Authorizes the target
// through an ACTIVE pilot.organization_memberships row for this specific
// (account, organization) pair -- not the account's single denormalized
// pilot.accounts.organization_id -- so a legitimate secondary membership
// (the account's primary organization is elsewhere, but it also holds an
// active membership here) is correctly revocable, while a foreign
// organization, a missing membership, and an inactive membership are all
// correctly denied. Rejects with the same generic error for every denial
// reason (account doesn't exist, no membership in this organization, an
// inactive membership, or a platform owner), so none of those conditions
// can be distinguished from the response. Only revokes that account's
// sessions scoped to this organization: sessions the same account holds in
// any other organization are left untouched.
export async function revokeAllSessionsForAccountInOrganization(accountId: string, organizationId: string): Promise<void> {
  const membership = await queryOne<{ account_id: string; is_platform_owner: boolean }>(
    `select a.account_id, a.is_platform_owner
     from pilot.organization_memberships om
     join pilot.accounts a on a.account_id = om.account_id
     where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true`,
    [accountId, organizationId],
  );

  if (!membership || membership.is_platform_owner) {
    throw new Error('Account not found or cannot be revoked');
  }

  await query(
    'update pilot.session_tokens set revoked_at = now() where account_id = $1 and organization_id = $2 and revoked_at is null',
    [accountId, organizationId],
  );
}

// Deletes session rows once EITHER terminal condition has been true for at
// least `retentionDays`: the row expired that long ago, OR it was revoked
// that long ago. Only one condition needs to hold, not both -- a session
// that was revoked immediately after being minted (expires_at still far in
// the future) is just as eligible for cleanup, on revoked_at alone, as a
// session that simply expired without ever being revoked. This keeps a
// short forensic window on both kinds of terminal session before
// hard-deleting them.
//
// retentionDays is validated here (not just by the CLI wrapper) so any
// caller -- script or application code -- gets the same rejection of
// malformed input (e.g. "7abc", decimals, zero, negative, NaN, or an
// excessive value).
export async function cleanupExpiredSessions(retentionDays: number = 7): Promise<{ deletedCount: number }> {
  const validDays = parseRetentionDays(retentionDays);

  const rows = await query<{ token_hash: string }>(
    `delete from pilot.session_tokens
     where (expires_at < now() - ($1 || ' days')::interval)
        or (revoked_at is not null and revoked_at < now() - ($1 || ' days')::interval)
     returning token_hash`,
    [validDays],
  );

  return { deletedCount: rows.length };
}

export async function resetAccountPin(accountId: string, pin: string, organizationId: string): Promise<void> {
  validatePinPolicy(pin);
  const pinHash = await hashPin(pin);

  await withTransaction(async (client) => {
    // Verify ownership, change the PIN, and revoke every existing session
    // for this account in one transaction: if any step fails, nothing
    // commits, so a caller is never told a reset succeeded while the old
    // PIN or an old session is still valid.
    //
    // must_change_pin is set because a reset PIN is always known to somebody
    // other than the athlete -- the admin who typed it, and in the case of the
    // "back to the starting PIN" button in /admin/people, anyone at all, since
    // that PIN is published. The admin UI already tells the athlete they will
    // have to choose a new one on next sign-in; without this line that promise
    // was simply untrue, and the reset handed out full access on 123456.
    const result = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set pin_hash = $1, must_change_pin = true, updated_at = now()
       where account_id = $2
         and organization_id = $3
         and role = 'athlete'
         and is_platform_owner = false
       returning account_id`,
      [pinHash, accountId, organizationId],
    );

    // Leads with "Not found:" because jsonError maps by message prefix: any
    // other wording is masked as a 500 "Internal server error", which tells the
    // admin their reset broke the server rather than that they picked an
    // account this reset cannot apply to.
    if (result.rows.length === 0) {
      throw new Error('Not found: no such account, or it cannot be reset');
    }

    await revokeAllSessionsForAccountTx(client, accountId);
  });
}

/**
 * Repair one account stranded by the pre-#46 guardian provisioning defect:
 * a non-athlete row on auth_provider 'ppbf_local' has NO working login path
 * (PIN login is athlete-only, Microsoft login matches only provider
 * 'microsoft', and resolvePrincipal revokes non-athlete local sessions on
 * sight). Flipping the provider makes the row matchable by the Microsoft
 * callback's lower(login_email) lookup — which is why a login email is
 * required — and clears the useless pin_hash the old path wrote.
 *
 * Deliberately per-account, never bulk: the stranded-guardians check
 * (pilot-check-stranded-guardians.mjs / check-database.yml) prescribes an
 * explicit operator decision per row, and the WHERE below makes every guard
 * structural — wrong org, athlete rows, already-microsoft rows, inactive
 * rows, and rows with no login email all refuse rather than half-repair.
 */
export async function repairStrandedGuardianAuthProvider(
  accountId: string,
  organizationId: string,
): Promise<{ account_id: string; role: PilotRole; login_email: string }> {
  const repaired = await queryOne<{ account_id: string; role: PilotRole; login_email: string }>(
    `update pilot.accounts
     set auth_provider = 'microsoft',
         pin_hash = null,
         must_change_pin = false,
         updated_at = now()
     where account_id = $1
       and organization_id = $2
       and auth_provider = 'ppbf_local'
       and role <> 'athlete'
       and is_platform_owner = false
       and active_flag = true
       and login_email is not null
       and login_email <> ''
     returning account_id, role, login_email`,
    [accountId, organizationId],
  );
  if (!repaired) {
    throw new Error(
      'Not found: no active, stranded (ppbf_local) non-athlete account with a login email '
      + 'matches that account_id in this organization',
    );
  }
  return repaired;
}

export async function activateAccountPin(accountId: string, pin: string, organizationId: string): Promise<void> {
  validatePinPolicy(pin);
  const pinHash = await hashPin(pin);

  await withTransaction(async (client) => {
    // must_change_pin is set for the same reason resetAccountPin sets it, and
    // it was the only one of the three PIN paths that did not. An activation
    // PIN is typed by an administrator, so it is a PIN somebody other than the
    // athlete knows -- and until this line, an athlete promoted from intake
    // signed in on it and was never once asked to replace it. The whole
    // enforcement chain hangs on this boolean: requirePrincipal refuses every
    // route while it is set (http.ts), and roleSession.ts and /athlete/sign-in
    // both send that state to /change-pin. At false, none of it fires.
    //
    // Measured before changing it, against real Postgres: createAthleteAccount
    // left it true, resetAccountPin left it true, and activateAccountPin left
    // it false because pilot.accounts.must_change_pin defaults to false and
    // this UPDATE never named it.
    //
    // The cost is one extra prompt when an admin activates with the athlete
    // standing next to them having chosen the PIN themselves. That is the
    // right trade in a system holding youth records: the alternative is an
    // admin-known credential that grants full athlete access indefinitely.
    const result = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set pin_hash = $1,
           active_flag = true,
           must_change_pin = true,
           updated_at = now()
       where account_id = $2
         and organization_id = $3
         and role = 'athlete'
         and is_platform_owner = false
       returning account_id`,
      [pinHash, accountId, organizationId],
    );

    if (result.rows.length === 0) {
      throw new Error('Not found: no such account, or it cannot be activated');
    }

    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', true)
       on conflict (account_id, organization_id) do update
         set role = 'athlete',
             active_flag = true,
             updated_at = now()`,
      [accountId, organizationId],
    );

    await revokeAllSessionsForAccountTx(client, accountId);
  });
}

export async function createAthleteAccount(
  accountId: string,
  athleteId: string,
  organizationIdOrLegacyPin: string,
  maybeOrganizationId?: string,
): Promise<void> {
  const organizationId = maybeOrganizationId ?? organizationIdOrLegacyPin;

  await withTransaction(async (client) => {
    const athlete = await client.query<{ athlete_id: string }>(
      `select athlete_id
       from pilot.athletes
       where athlete_id = $1 and organization_id = $2`,
      [athleteId, organizationId],
    );

    if (athlete.rows.length === 0) {
      throw new Error('Athlete not found in organization');
    }

    const existingAthleteBinding = await client.query<{ account_id: string }>(
      `select account_id
       from pilot.accounts
       where athlete_id = $1 and organization_id = $2
       limit 1`,
      [athleteId, organizationId],
    );

    if (existingAthleteBinding.rows.length > 0 && existingAthleteBinding.rows[0].account_id !== accountId) {
      throw new Error('Athlete is already linked to another account');
    }

    const existingAccount = await client.query<{ organization_id: string }>(
      `select organization_id
       from pilot.accounts
       where account_id = $1
       limit 1`,
      [accountId],
    );

    if (existingAccount.rows.length > 0) {
      if (existingAccount.rows[0].organization_id !== organizationId) {
        throw new Error('Account already exists in another organization');
      }
      throw new Error('Account already exists');
    }

    // The account is created live, on the shared bootstrap PIN, rather than
    // inert and awaiting an activation code. The admin can now tell the
    // athlete their sign-in ID and the starting PIN in the same breath.
    //
    // Creating it active is only safe because must_change_pin is set:
    // requirePrincipal refuses every route while that flag is true, so the
    // one thing this account can do until the athlete picks their own PIN is
    // pick their own PIN. See http.ts.
    const bootstrapPinHash = await hashPin(DEFAULT_FIRST_LOGIN_PIN);

    await client.query(
      `insert into pilot.accounts
         (account_id, role, organization_id, athlete_id, pin_hash, must_change_pin, active_flag, is_platform_owner)
       values ($1, 'athlete', $2, $3, $4, true, true, false)`,
      [accountId, organizationId, athleteId, bootstrapPinHash],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', true)
       on conflict (account_id, organization_id) do update
         set role = 'athlete',
             active_flag = true,
             updated_at = now()`,
      [accountId, organizationId],
    );
  });
}

/**
 * The athlete replacing their bootstrap PIN with one of their own. This is
 * the only thing an account with must_change_pin set is allowed to do.
 *
 * Every other session for the account is revoked on success: if the starting
 * PIN was guessed during the window before the athlete first signed in, this
 * is the moment that intruder's session dies.
 */
export async function changeOwnPin(accountId: string, currentPin: string, newPin: string): Promise<void> {
  validatePinPolicy(newPin);
  // Rejecting same-as-current is not enough on its own. An athlete who moved off
  // the starting PIN and later came back to it would clear must_change_pin while
  // sitting on a PIN that is published in pinPolicy.ts and printed in the admin
  // UI -- full access to anyone who knows the sign-in ID.
  assertChosenPinAllowed(newPin);

  if (currentPin.trim() === newPin.trim()) {
    throw new Error('PIN must be different from the current PIN');
  }

  await withTransaction(async (client) => {
    const account = await client.query<{ pin_hash: string | null; role: PilotRole; active_flag: boolean }>(
      `select pin_hash, role, active_flag
       from pilot.accounts
       where account_id = $1 and auth_provider = 'ppbf_local'`,
      [accountId],
    );

    const row = account.rows[0];
    // Only someone whose credential IS a PIN may change one. Asks the policy
    // rather than naming the role -- this was the third independent copy of the
    // athlete-only rule, and the drift guard found it after two rounds of
    // reading the file missed it.
    if (!row?.active_flag || !row.pin_hash || !usesPin({ role: row.role })) {
      console.warn('pilot-auth change-pin rejected', { accountId, reason: 'ineligible_account' });
      throw new Error('Unauthorized');
    }

    if (!(await verifyPin(currentPin, row.pin_hash))) {
      // The route reaching this is gated only on a live session cookie, not
      // on the PIN itself -- a stolen-but-live session is enough to guess
      // here repeatedly, which is exactly the scenario a forensic trail
      // needs to be reconstructable for.
      console.warn('pilot-auth change-pin rejected', { accountId, reason: 'wrong_current_pin' });
      throw new Error('Unauthorized: current PIN is incorrect');
    }

    await client.query(
      `update pilot.accounts
       set pin_hash = $1,
           must_change_pin = false,
           updated_at = now()
       where account_id = $2`,
      [await hashPin(newPin), accountId],
    );

    await revokeAllSessionsForAccountTx(client, accountId);
  });
}

export async function createOrUpdateAthleteAccount(
  accountId: string,
  athleteId: string,
  organizationIdOrLegacyPin: string,
  maybeOrganizationId?: string,
): Promise<void> {
  const organizationId = maybeOrganizationId ?? organizationIdOrLegacyPin;

  // Check if account exists and verify ownership
  const existingAccount = await query<{ organization_id: string }>(
    'select organization_id from pilot.accounts where account_id = $1',
    [accountId]
  );

  if (existingAccount.length > 0) {
    const existingOrgId = existingAccount[0].organization_id;
    if (existingOrgId !== organizationId) {
      // Account exists in a different organization—reject to prevent cross-tenant takeover
      throw new Error('Account already exists in another organization');
    }

    await withTransaction(async (client) => {
      // Same organization—update is allowed. The PIN is changing, so revoke
      // every existing session for this account in the same transaction.
      await client.query(
        `update pilot.accounts set
           role = $1,
           athlete_id = $2,
           pin_hash = $3,
           active_flag = $4,
           updated_at = now()
         where account_id = $5 and organization_id = $6`,
        ['athlete', athleteId, null, false, accountId, organizationId],
      );
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'athlete', false)
         on conflict (account_id, organization_id) do update
           set role = 'athlete',
               active_flag = false,
               updated_at = now()`,
        [accountId, organizationId],
      );
      await revokeAllSessionsForAccountTx(client, accountId);
    });
  } else {
    await withTransaction(async (client) => {
      // New account—create it
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [accountId, 'athlete', organizationId, athleteId, null, false, false],
      );
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
         values ($1, $2, 'athlete', false)
         on conflict (account_id, organization_id) do update
           set role = 'athlete',
               active_flag = false,
               updated_at = now()`,
        [accountId, organizationId],
      );
    });
  }
}

/**
 * Create an athlete account awaiting activation, and refuse if one already
 * exists.
 *
 * createOrUpdateAthleteAccount is an upsert, and its update branch is
 * destructive by design: it nulls pin_hash, clears active_flag and revokes
 * every session, which is right for a deliberate credential reset and wrong for
 * anything called "create". A replayed or repeated create would lock a child
 * out of their own account with no operator intending it.
 *
 * The existence check runs inside the same transaction as the insert, so two
 * concurrent creates cannot both pass it. Intake promotion keeps the upsert --
 * re-running a review there is meant to re-provision.
 */
export async function createAthleteAccountPendingActivation(
  accountId: string,
  athleteId: string,
  organizationId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<{ organization_id: string }>(
      'select organization_id from pilot.accounts where account_id = $1 limit 1',
      [accountId],
    );

    if (existing.rows.length > 0) {
      // Same message either way. Which gym holds an account id is not
      // something a caller who does not already have it should learn here.
      throw new Error('Account already exists');
    }

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
       values ($1, 'athlete', $2, $3, null, false, false)`,
      [accountId, organizationId, athleteId],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'athlete', false)
       on conflict (account_id, organization_id) do update
         set role = 'athlete',
             active_flag = false,
             updated_at = now()`,
      [accountId, organizationId],
    );
  });
}

// The three constructors below write local PIN accounts for privileged roles.
// Every account they produce is unusable: loginWithAccountIdAndPin admits only
// 'athlete', and resolvePrincipal revokes on sight any live session belonging
// to a ppbf_local account whose role is not 'athlete'. So a coach, parent or
// admin created here can never sign in.
//
// They are retained only because the session-revocation suites use them as
// fixtures for rows that still exist in deployed databases. Do NOT wire them to
// new callers -- createOrUpdateMicrosoftStaffAccount in staffProvisioning.ts is
// the supported path for every non-athlete role. Intake promotion used
// createParentAccount until it was moved to that path; nothing calls these in
// production now.
/** @deprecated Produces an account that cannot authenticate. See the note above. */
export async function createCoachAccount(accountId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

  // Check if account exists and verify ownership
  const existingAccount = await query<{ organization_id: string }>(
    'select organization_id from pilot.accounts where account_id = $1',
    [accountId]
  );

  if (existingAccount.length > 0) {
    const existingOrgId = existingAccount[0].organization_id;
    if (existingOrgId !== organizationId) {
      throw new Error('Account already exists in another organization');
    }

    await withTransaction(async (client) => {
      // Same organization—update is allowed. The PIN is changing, so revoke
      // every existing session for this account in the same transaction.
      await client.query(
        `update pilot.accounts set
           role = $1,
           pin_hash = $2,
           active_flag = $3,
           updated_at = now()
         where account_id = $4 and organization_id = $5`,
        ['coach', pinHash, true, accountId, organizationId],
      );
      await assignOrganizationMembershipTx(client, accountId, organizationId, 'coach');
      await revokeAllSessionsForAccountTx(client, accountId);
    });
  } else {
    await withTransaction(async (client) => {
      // New account—create it
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [accountId, 'coach', organizationId, null, pinHash, true, false],
      );
      await assignOrganizationMembershipTx(client, accountId, organizationId, 'coach');
    });
  }
}

/** @deprecated Produces an account that cannot authenticate. See the note above createCoachAccount. */
export async function createParentAccount(accountId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

  // Check if account exists and verify ownership
  const existingAccount = await query<{ organization_id: string }>(
    'select organization_id from pilot.accounts where account_id = $1',
    [accountId]
  );

  if (existingAccount.length > 0) {
    const existingOrgId = existingAccount[0].organization_id;
    if (existingOrgId !== organizationId) {
      throw new Error('Account already exists in another organization');
    }

    await withTransaction(async (client) => {
      // Same organization—update is allowed. The PIN is changing, so revoke
      // every existing session for this account in the same transaction.
      await client.query(
        `update pilot.accounts set
           role = $1,
           pin_hash = $2,
           active_flag = $3,
           updated_at = now()
         where account_id = $4 and organization_id = $5`,
        ['parent', pinHash, true, accountId, organizationId],
      );
      await assignOrganizationMembershipTx(client, accountId, organizationId, 'parent');
      await revokeAllSessionsForAccountTx(client, accountId);
    });
  } else {
    await withTransaction(async (client) => {
      // New account—create it
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [accountId, 'parent', organizationId, null, pinHash, true, false],
      );
      await assignOrganizationMembershipTx(client, accountId, organizationId, 'parent');
    });
  }
}

/** @deprecated Produces an account that cannot authenticate. See the note above createCoachAccount. */
export async function createOrRotateAdminAccount(
  accountId: string,
  pin: string,
  organizationId: string,
  role: 'organization_admin' | 'platform_owner' | 'board' = 'organization_admin',
): Promise<void> {
  const pinHash = await hashPin(pin);
  const isPlatformOwner = role === 'platform_owner';

  await withTransaction(async (client) => {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (account_id) do update set
         role = excluded.role,
         organization_id = excluded.organization_id,
         athlete_id = excluded.athlete_id,
         pin_hash = excluded.pin_hash,
         active_flag = excluded.active_flag,
         is_platform_owner = excluded.is_platform_owner`,
      [accountId, role, organizationId, null, pinHash, true, isPlatformOwner],
    );

    // Without this, a newly created or rotated admin has no matching active
    // organization_memberships row, and resolvePrincipal's active-membership
    // join would then reject every session they try to establish.
    await assignOrganizationMembershipTx(client, accountId, organizationId, role);
    await revokeAllSessionsForAccountTx(client, accountId);
  });
}

export async function createOrganization(organizationId: string, organizationName: string, createdBy: string): Promise<void> {
  // The reserved organization owning the platform evidence baseline is not a
  // gym, and this is an upsert: a platform_owner POSTing that id would rename
  // the baseline shelf and seed it with the compliance rules and safety gates
  // below, as though it had a floor and members. It is created by its migration
  // and by nothing else.
  if (isPlatformLibraryOrganization(organizationId.trim())) {
    throw new Error('RESERVED_ORGANIZATION_ID');
  }

  // Organization, compliance rules, and safety gates are created together, in
  // one transaction. The seed migrations only reach organizations that
  // existed when an operator ran them, so a gym created afterwards through
  // this route started with an empty rule set and no safety gate to evaluate
  // contact observations against -- the same gap seedDefaultComplianceRules
  // was written to close, now closed for safety_gates too. The transaction
  // means the organization cannot half-exist either.
  await withTransaction(async (client) => {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status, created_by_account_id)
       values ($1, $2, 'active', $3)
       on conflict (organization_id) do update
         set organization_name = excluded.organization_name,
             status = 'active',
             updated_at = now()`,
      [organizationId, organizationName, createdBy],
    );

    await seedDefaultComplianceRules(organizationId, client);
    await seedDefaultSafetyGates(organizationId, client);
  });
}

export async function createOrUpdateMicrosoftPlatformOwnerAccount(params: {
  loginEmail: string;
  organizationId: string;
  accountIdHint?: string;
}): Promise<{ accountId: string; organizationId: string; created: boolean }> {
  const normalizedEmail = params.loginEmail.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Missing loginEmail');
  }

  const existingByEmail = await queryOne<{ account_id: string }>(
    'select account_id from pilot.accounts where lower(login_email) = $1',
    [normalizedEmail],
  );

  const accountId = existingByEmail?.account_id || params.accountIdHint?.trim() || normalizedEmail;
  const existingByAccountId = await queryOne<{ account_id: string }>('select account_id from pilot.accounts where account_id = $1', [accountId]);

  await withTransaction(async (client) => {
    await client.query(
      `insert into pilot.accounts (
         account_id,
         login_email,
         auth_provider,
         role,
         organization_id,
         is_platform_owner,
         athlete_id,
         pin_hash,
         active_flag
       )
       values ($1, $2, 'microsoft', 'platform_owner', $3, true, null, null, true)
       on conflict (account_id) do update set
         login_email = excluded.login_email,
         auth_provider = 'microsoft',
         role = 'platform_owner',
         organization_id = excluded.organization_id,
         is_platform_owner = true,
         athlete_id = null,
         pin_hash = null,
         active_flag = true,
         updated_at = now()`,
      [accountId, normalizedEmail, params.organizationId],
    );

    await assignOrganizationMembershipTx(client, accountId, params.organizationId, 'platform_owner');

    if (existingByAccountId) {
      // Provider/role/org were (re)assigned on an existing account -- revoke
      // any sessions minted under the previous configuration.
      await revokeAllSessionsForAccountTx(client, accountId);
    }
  });

  return {
    accountId,
    organizationId: params.organizationId,
    created: !existingByAccountId,
  };
}

export async function setOrganizationStatus(
  organizationId: string,
  status: 'active' | 'inactive' | 'suspended' | 'pending',
): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await client.query<{ organization_id: string }>(
      `update pilot.organizations
       set status = $2,
           updated_at = now()
       where organization_id = $1
       returning organization_id`,
      [organizationId, status],
    );

    // A suspension that matched no organization must not report success.
    if (rows.rows.length === 0) {
      throw new Error('Not found: no such organization');
    }

    if (status !== 'active') {
      // Revoke every session scoped to this organization so members can't
      // keep operating in it under the old status.
      await client.query(
        'update pilot.session_tokens set revoked_at = now() where organization_id = $1 and revoked_at is null',
        [organizationId],
      );
    }
  });
}

/**
 * The role an account holds in a gym, or null if it holds none there.
 *
 * Used to keep the platform tier off athlete accounts. A platform owner
 * suspending a compromised staff account is legitimate cross-gym operation; a
 * platform owner deactivating a child and revoking their sessions is the thing
 * the PIN directory, PIN reset and revoke routes all already refuse.
 */
export async function getAccountRoleInOrganization(
  accountId: string,
  organizationId: string,
): Promise<PilotRole | null> {
  const rows = await query<{ role: PilotRole }>(
    'select role from pilot.accounts where account_id = $1 and organization_id = $2 limit 1',
    [accountId, organizationId],
  );
  return rows.length > 0 ? rows[0].role : null;
}

export async function setAccountActiveStatus(accountId: string, organizationId: string, activeFlag: boolean): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set active_flag = $3,
           updated_at = now()
       where account_id = $1 and organization_id = $2
       returning account_id`,
      [accountId, organizationId, activeFlag],
    );

    if (rows.rows.length === 0) {
      throw new Error('Missing account_id or organization_id');
    }

    await client.query(
      `update pilot.organization_memberships
       set active_flag = $3,
           updated_at = now()
       where account_id = $1 and organization_id = $2`,
      [accountId, organizationId, activeFlag],
    );

    if (!activeFlag) {
      await revokeAllSessionsForAccountTx(client, accountId);
    }
  });
}

export async function upsertOrganizationMembership(accountId: string, organizationId: string, role: PilotRole, activeFlag: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, $4)
       on conflict (account_id, organization_id) do update
         set role = excluded.role,
             active_flag = excluded.active_flag,
             updated_at = now()`,
      [accountId, organizationId, role, activeFlag],
    );

    const rows = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set role = $3,
           organization_id = $2,
           active_flag = $4,
           is_platform_owner = case when $3 = 'platform_owner' then true else false end,
           updated_at = now()
       where account_id = $1
       returning account_id`,
      [accountId, organizationId, role, activeFlag],
    );

    if (rows.rows.length === 0) {
      throw new Error('Missing account_id');
    }

    // pilot.accounts.role/organization_id are read live on every request
    // (resolvePrincipal doesn't scope role to the session's own
    // organization), so ANY membership mutation here can change what an
    // existing session resolves to -- a brand-new membership in another
    // organization, a role change, a reactivation, or a deactivation all
    // rewrite those columns. Fail closed and always revoke rather than try
    // to prove a specific case didn't change anything: an old session in
    // organization A must never be able to inherit a role or organization
    // assigned here.
    await revokeAllSessionsForAccountTx(client, accountId);
  });
}

export async function transferOrganizationAdmin(
  fromAccountId: string,
  toAccountId: string,
  organizationId: string,
  demoteRole: Exclude<PilotRole, 'platform_owner' | 'organization_admin'>,
): Promise<void> {
  await withTransaction(async (client) => {
    // The promote used to match on account_id alone, so it both moved an
    // account in from another organization and could strip platform ownership
    // off the owner's own row. Both are structural refusals now: the WHERE
    // pins the target to this organization, and the platform owner is excluded
    // outright rather than demoted into an organization seat.
    const promotedRows = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set role = 'organization_admin',
           active_flag = true,
           updated_at = now()
       where account_id = $1
         and organization_id = $2
         and is_platform_owner = false
         and role <> 'platform_owner'
       returning account_id`,
      [toAccountId, organizationId],
    );

    if (promotedRows.rows.length === 0) {
      throw new Error('Missing target account for admin transfer');
    }

    const demotedRows = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set role = $3,
           active_flag = true,
           is_platform_owner = false,
           updated_at = now()
       where account_id = $1 and organization_id = $2
       returning account_id`,
      [fromAccountId, organizationId, demoteRole],
    );

    if (demotedRows.rows.length === 0) {
      throw new Error('Missing source admin in organization');
    }

    await assignOrganizationMembershipTx(client, toAccountId, organizationId, 'organization_admin');
    await assignOrganizationMembershipTx(client, fromAccountId, organizationId, demoteRole);
    await revokeAllSessionsForAccountTx(client, fromAccountId);
    await revokeAllSessionsForAccountTx(client, toAccountId);
  });
}

// The same structural refusals transferOrganizationAdmin carries, for the
// same reasons: this used to match on account_id alone, overwrite
// organization_id, and clear is_platform_owner unconditionally -- so a
// promotion could silently move an account across organizations, mutate a
// foreign tenant's account, or strip platform ownership off the owner's own
// row, and a typo'd account_id succeeded against nothing while still writing
// a membership row for an account that was never promoted. The WHERE now
// pins the target to the named organization and excludes the platform owner
// outright; zero matched rows throws, which rolls the transaction back
// before any membership write. Moving an account between organizations is a
// different, explicit operation -- it must never be a side effect of
// assigning an admin. active_flag is deliberately untouched: promoting a
// deactivated account must not silently reactivate it.
/**
 * Grants or revokes `has_master_shadow_access` -- the standing
 * cross-organization privilege flag on `pilot.accounts`.
 *
 * Before this function existed, the column had no product provisioning path
 * at all. It is read by both login paths (loginWithAccountIdAndPin and
 * loginWithMicrosoftEmail) and by resolvePrincipal on every request, and the
 * PIN login route echoes it in the JSON response body -- but nothing in the
 * application ever set it. The only way an account ever held it was a direct
 * database write against a column that defaults to false.
 *
 * This is a platform-wide attribute of the account, not a per-organization
 * one -- pilot.organization_memberships has nothing comparable, and neither
 * does pilot.accounts.role -- so unlike setAccountActiveStatus this does not
 * take an organization_id to scope the match. account_id alone is the primary
 * key of pilot.accounts.
 *
 * Callers are NOT re-checked here. Gating who may call this lives at the
 * route layer via requireRole(['platform_owner']), matching every other
 * platform-level cross-org grant already in this codebase (see
 * promoteAccountToOrganizationAdmin, transferOrganizationAdmin, and
 * setOrganizationStatus, all gated the same way, all one layer up from their
 * own db function).
 *
 * Athlete and parent targets are refused outright, at this layer, so no
 * future caller of this function can skip the check by forgetting to repeat
 * it. Those two roles are minor-linked and scoped to self/family by design;
 * there is no legitimate reason for a child's or guardian's account to carry
 * a platform-wide cross-organization export privilege.
 *
 * No session revocation on revoke: resolvePrincipal reads
 * has_master_shadow_access live from the database on every request rather
 * than caching it on the session token, so a revoke here takes effect on the
 * very next request without needing to invalidate anything.
 */
export async function setAccountMasterShadowAccess(
  accountId: string,
  granted: boolean,
): Promise<{ accountId: string; role: PilotRole; organizationId: string | null; hasMasterShadowAccess: boolean }> {
  const result = await queryOne<{
    account_id: string;
    role: PilotRole;
    organization_id: string | null;
    has_master_shadow_access: boolean;
  }>(
    `update pilot.accounts
     set has_master_shadow_access = $2,
         updated_at = now()
     where account_id = $1
       and role not in ('athlete', 'parent')
     returning account_id, role, organization_id, has_master_shadow_access`,
    [accountId, granted],
  );

  if (!result) {
    throw new Error('Not found: no such account, or its role cannot hold cross-organization access');
  }

  return {
    accountId: result.account_id,
    role: result.role,
    organizationId: result.organization_id,
    hasMasterShadowAccess: result.has_master_shadow_access,
  };
}

export async function promoteAccountToOrganizationAdmin(accountId: string, organizationId: string): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set role = 'organization_admin',
           updated_at = now()
       where account_id = $1
         and organization_id = $2
         and is_platform_owner = false
         and role <> 'platform_owner'
       returning account_id`,
      [accountId, organizationId],
    );

    if (rows.rows.length === 0) {
      throw new Error('Missing target account in organization');
    }

    await assignOrganizationMembershipTx(client, accountId, organizationId, 'organization_admin');
    await revokeAllSessionsForAccountTx(client, accountId);
  });
}
