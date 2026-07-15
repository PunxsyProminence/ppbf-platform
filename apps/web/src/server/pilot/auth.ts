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
}

interface AccountRow {
  account_id: string;
  role: PilotRole;
  organization_id: string | null;
  is_platform_owner: boolean;
  athlete_id: string | null;
  pin_hash: string;
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
       a.pin_hash,
       a.active_flag,
       o.status as organization_status
     from pilot.accounts a
     left join pilot.organizations o on o.organization_id = a.organization_id
     where a.account_id = $1`,
    [accountId],
  );

  if (!data?.active_flag) {
    return null;
  }

  const organizationId = data.organization_id || getPilotDefaultOrganizationId();
  if (!data.is_platform_owner && data.organization_status && data.organization_status !== 'active') {
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
    active_flag: boolean;
    organization_status: string | null;
  }>(
    `select
       a.account_id,
       a.role,
       coalesce(st.organization_id, a.organization_id) as organization_id,
       a.is_platform_owner,
       a.athlete_id,
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
  };
}

export async function logoutWithToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);

  await query('update pilot.session_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [tokenHash]);
}

export async function revokeAllSessionsForAccount(accountId: string): Promise<void> {
  await query('update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null', [accountId]);
}

export async function resetAccountPin(accountId: string, pin: string): Promise<void> {
  const pinHash = await hashPin(pin);

  await query('update pilot.accounts set pin_hash = $1 where account_id = $2', [pinHash, accountId]);

  await revokeAllSessionsForAccount(accountId);
}

export async function createAthleteAccount(accountId: string, athleteId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

  await query(
    'insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner) values ($1, $2, $3, $4, $5, $6, $7)',
    [accountId, 'athlete', organizationId, athleteId, pinHash, true, false],
  );
}

export async function createParentAccount(accountId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

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
    [accountId, 'parent', organizationId, null, pinHash, true, false],
  );
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

export async function setOrganizationStatus(
  organizationId: string,
  status: 'active' | 'inactive' | 'suspended' | 'pending',
): Promise<void> {
  await query('update pilot.organizations set status = $2, updated_at = now() where organization_id = $1', [organizationId, status]);
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
