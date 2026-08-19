// The three constructors below write local PIN accounts for privileged roles.
// Every account they produce is unusable: loginWithAccountIdAndPin admits only
// 'athlete', and resolvePrincipal revokes on sight any live session belonging
// to a ppbf_local account whose role is not 'athlete'. So a coach, parent or
// admin created here can never sign in.
//
// They live here, outside auth.ts, because the only reason they still exist
// is that the session-revocation suites use them as fixtures for rows that
// still exist in deployed databases. Do NOT wire them to new callers --
// createOrUpdateMicrosoftStaffAccount in staffProvisioning.ts is the
// supported path for every non-athlete role. Intake promotion used
// createParentAccount until it was moved to that path; nothing calls these in
// production now.

import { hashPin } from './security';
import { query, withTransaction } from './db';
import { assignOrganizationMembershipTx, revokeAllSessionsForAccountTx } from './auth';

/** @deprecated Produces an account that cannot authenticate. See the file-level note above. */
export async function createCoachAccount(accountId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

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
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [accountId, 'coach', organizationId, null, pinHash, true, false],
      );
      await assignOrganizationMembershipTx(client, accountId, organizationId, 'coach');
    });
  }
}

/** @deprecated Produces an account that cannot authenticate. See the file-level note above. */
export async function createParentAccount(accountId: string, pin: string, organizationId: string): Promise<void> {
  const pinHash = await hashPin(pin);

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
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, athlete_id, pin_hash, active_flag, is_platform_owner)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [accountId, 'parent', organizationId, null, pinHash, true, false],
      );
      await assignOrganizationMembershipTx(client, accountId, organizationId, 'parent');
    });
  }
}

/** @deprecated Produces an account that cannot authenticate. See the file-level note above. */
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
