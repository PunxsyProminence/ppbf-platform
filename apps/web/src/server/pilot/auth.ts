import type { NextRequest } from 'next/server';

import type { PilotRole } from './contracts';
import { getPilotDefaultOrganizationId, PILOT_SESSION_COOKIE } from './env';
import { createOpaqueToken, hashPin, hashToken, verifyPin } from './security';
import { query, queryOne } from './db';

export interface PilotPrincipal {
  accountId: string;
  role: PilotRole;
  organizationId: string;
  athleteId: string | null;
  sessionToken: string;
  authProvider: 'ppbf_local' | 'microsoft';
}

interface AccountRow {
  account_id: string;
  role: PilotRole;
  organization_id: string | null;
  is_platform_owner: boolean;
  athlete_id: string | null;
  auth_provider: 'ppbf_local' | 'microsoft';
  pin_hash: string | null;
  active_flag: boolean;
  organization_status: string | null;
}

interface FederatedAccountRow {
  account_id: string;
  role: PilotRole;
  organization_id: string | null;
  is_platform_owner: boolean;
  athlete_id: string | null;
  auth_provider: 'ppbf_local' | 'microsoft';
  active_flag: boolean;
  organization_status: string | null;
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
       a.active_flag,
       o.status as organization_status
     from pilot.accounts a
     left join pilot.organizations o on o.organization_id = a.organization_id
     where a.account_id = $1
       and a.auth_provider = 'ppbf_local'`,
    [accountId],
  );

  if (!data?.active_flag) {
    return null;
  }

  const organizationId = data.organization_id || getPilotDefaultOrganizationId();
  if (!data.is_platform_owner && data.organization_status && data.organization_status !== 'active') {
    return null;
  }

  if (!data.pin_hash) {
    return null;
  }

  const pinIsValid = await verifyPin(pin, data.pin_hash);
  if (!pinIsValid) {
    return null;
  }

  const token = createOpaqueToken();
  const tokenHash = hashToken(token);

  await query('insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)', [tokenHash, data.account_id, organizationId]);

  return {
    token,
    principal: {
      accountId: data.account_id,
      role: data.role,
      organizationId,
      athleteId: data.athlete_id,
      sessionToken: token,
      authProvider: data.auth_provider,
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

  const token = createOpaqueToken();
  const tokenHash = hashToken(token);
  await query('insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)', [tokenHash, data.account_id, organizationId]);

  return {
    token,
    principal: {
      accountId: data.account_id,
      role: data.role,
      organizationId,
      athleteId: data.athlete_id,
      sessionToken: token,
      authProvider: data.auth_provider,
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
    auth_provider: 'ppbf_local' | 'microsoft';
    active_flag: boolean;
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
       o.status as organization_status
     from pilot.session_tokens st
     join pilot.accounts a on a.account_id = st.account_id
     left join pilot.organizations o on o.organization_id = coalesce(st.organization_id, a.organization_id)
     where st.token_hash = $1 and st.revoked_at is null`,
    [tokenHash],
  );

  if (!row?.active_flag) {
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
  };
}

export async function logoutWithToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);

  await query('update pilot.session_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [tokenHash]);
}

export async function revokeAllSessionsForAccount(accountId: string): Promise<void> {
  await query('update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null', [accountId]);
}

export async function resetAccountPin(accountId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

  // Verify account exists, belongs to the organization, and is not a platform owner
  const result = await query<{ account_id: string }>(
    'select account_id from pilot.accounts where account_id = $1 and organization_id = $2 and is_platform_owner = false',
    [accountId, organizationId]
  );

  if (!result.length) {
    throw new Error('Account not found or cannot be reset');
  }

  // Update PIN only if account belongs to this organization and is not platform owner
  const updateResult = await query(
    'update pilot.accounts set pin_hash = $1 where account_id = $2 and organization_id = $3 and is_platform_owner = false',
    [pinHash, accountId, organizationId]
  );

  if (!updateResult.length) {
    throw new Error('Failed to reset PIN');
  }

  await revokeAllSessionsForAccount(accountId);
}

export async function createAthleteAccount(accountId: string, athleteId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

  await query(
    'insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner) values ($1, $2, $3, $4, $5, $6, $7)',
    [accountId, 'athlete', organizationId, athleteId, pinHash, true, false],
  );
}

export async function createOrUpdateAthleteAccount(accountId: string, athleteId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

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
    // Same organization—update is allowed
    await query(
      `update pilot.accounts set
         role = $1,
         athlete_id = $2,
         pin_hash = $3,
         active_flag = $4,
         updated_at = now()
       where account_id = $5 and organization_id = $6`,
      ['athlete', athleteId, pinHash, true, accountId, organizationId],
    );
  } else {
    // New account—create it
    await query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, 'athlete', organizationId, athleteId, pinHash, true, false],
    );
  }
}

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
    // Same organization—update is allowed
    await query(
      `update pilot.accounts set
         role = $1,
         pin_hash = $2,
         active_flag = $3,
         updated_at = now()
       where account_id = $4 and organization_id = $5`,
      ['coach', pinHash, true, accountId, organizationId],
    );
  } else {
    // New account—create it
    await query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, 'coach', organizationId, null, pinHash, true, false],
    );
  }
}

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
    // Same organization—update is allowed
    await query(
      `update pilot.accounts set
         role = $1,
         pin_hash = $2,
         active_flag = $3,
         updated_at = now()
       where account_id = $4 and organization_id = $5`,
      ['parent', pinHash, true, accountId, organizationId],
    );
  } else {
    // New account—create it
    await query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, 'parent', organizationId, null, pinHash, true, false],
    );
  }
}

export async function createOrRotateAdminAccount(
  accountId: string,
  pin: string,
  organizationId: string,
  role: 'organization_admin' | 'platform_owner' = 'organization_admin',
): Promise<void> {
  const pinHash = await hashPin(pin);
  const isPlatformOwner = role === 'platform_owner';

  await query(
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

  await revokeAllSessionsForAccount(accountId);
}

export async function createOrganization(organizationId: string, organizationName: string, createdBy: string): Promise<void> {
  await query(
    `insert into pilot.organizations (organization_id, organization_name, status, created_by_account_id)
     values ($1, $2, 'active', $3)
     on conflict (organization_id) do update
       set organization_name = excluded.organization_name,
           status = 'active',
           updated_at = now()`,
    [organizationId, organizationName, createdBy],
  );
}

export async function assignOrganizationMembership(accountId: string, organizationId: string, role: PilotRole): Promise<void> {
  await query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)
     on conflict (account_id, organization_id) do update
       set role = excluded.role,
           active_flag = true,
           updated_at = now()`,
    [accountId, organizationId, role],
  );
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

  await query(
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

  await assignOrganizationMembership(accountId, params.organizationId, 'platform_owner');

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
  await query('update pilot.organizations set status = $2, updated_at = now() where organization_id = $1', [organizationId, status]);
}

export async function setAccountActiveStatus(accountId: string, organizationId: string, activeFlag: boolean): Promise<void> {
  const rows = await query<{ account_id: string }>(
    `update pilot.accounts
     set active_flag = $3,
         updated_at = now()
     where account_id = $1 and organization_id = $2
     returning account_id`,
    [accountId, organizationId, activeFlag],
  );

  if (rows.length === 0) {
    throw new Error('Missing account_id or organization_id');
  }

  await query(
    `update pilot.organization_memberships
     set active_flag = $3,
         updated_at = now()
     where account_id = $1 and organization_id = $2`,
    [accountId, organizationId, activeFlag],
  );

  if (!activeFlag) {
    await revokeAllSessionsForAccount(accountId);
  }
}

export async function upsertOrganizationMembership(accountId: string, organizationId: string, role: PilotRole, activeFlag: boolean): Promise<void> {
  await query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, $4)
     on conflict (account_id, organization_id) do update
       set role = excluded.role,
           active_flag = excluded.active_flag,
           updated_at = now()`,
    [accountId, organizationId, role, activeFlag],
  );

  const rows = await query<{ account_id: string }>(
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

  if (rows.length === 0) {
    throw new Error('Missing account_id');
  }

  if (!activeFlag) {
    await revokeAllSessionsForAccount(accountId);
  }
}

export async function transferOrganizationAdmin(
  fromAccountId: string,
  toAccountId: string,
  organizationId: string,
  demoteRole: Exclude<PilotRole, 'platform_owner' | 'organization_admin'>,
): Promise<void> {
  const promotedRows = await query<{ account_id: string }>(
    `update pilot.accounts
     set role = 'organization_admin',
         organization_id = $2,
         active_flag = true,
         is_platform_owner = false,
         updated_at = now()
     where account_id = $1
     returning account_id`,
    [toAccountId, organizationId],
  );

  if (promotedRows.length === 0) {
    throw new Error('Missing target account for admin transfer');
  }

  const demotedRows = await query<{ account_id: string }>(
    `update pilot.accounts
     set role = $3,
         active_flag = true,
         is_platform_owner = false,
         updated_at = now()
     where account_id = $1 and organization_id = $2
     returning account_id`,
    [fromAccountId, organizationId, demoteRole],
  );

  if (demotedRows.length === 0) {
    throw new Error('Missing source admin in organization');
  }

  await assignOrganizationMembership(toAccountId, organizationId, 'organization_admin');
  await assignOrganizationMembership(fromAccountId, organizationId, demoteRole);
  await revokeAllSessionsForAccount(fromAccountId);
  await revokeAllSessionsForAccount(toAccountId);
}

export async function promoteAccountToOrganizationAdmin(accountId: string, organizationId: string): Promise<void> {
  await query(
    `update pilot.accounts
     set role = 'organization_admin',
         organization_id = $2,
         is_platform_owner = false,
         updated_at = now()
     where account_id = $1`,
    [accountId, organizationId],
  );

  await assignOrganizationMembership(accountId, organizationId, 'organization_admin');
  await revokeAllSessionsForAccount(accountId);
}
