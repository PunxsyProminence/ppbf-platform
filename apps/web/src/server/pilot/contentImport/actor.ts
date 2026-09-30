import type { ClientBase } from 'pg';

import { PLATFORM_LIBRARY_ORGANIZATION_ID } from '../platformLibraryScope';
import { ContentImportRefusal } from './refusal';

// WHO MAY LOAD CONTENT INTO AN ORGANIZATION. Enforced here, in code, for both
// callers of the engine (the seed CLI now, the upload route later), because
// until now the rule lived only in workflow input text
// (seed-reference-data.yml, seed_account_id description) and the retired
// per-dataset loaders recorded whatever role the account had (their
// lib/seed-account-role.mjs refused only a missing account).
//
//   a gym organization (punxsy_prominence or any other):
//     the account exists, is active (active_flag), is not deleted
//     (deleted_at, data_retention_deletion migration :31), has role
//     organization_admin or admin, is NOT a platform owner, and holds an
//     ACTIVE pilot.organization_memberships row in THAT organization.
//   __platform__ (the shared research baseline):
//     a platform owner only. No account is a member there
//     (platformLibraryScope.ts: "no account may exist there"), so membership
//     is not asked.
//
// MEMBERSHIP, NOT THE HOME ORGANIZATION. pilot.accounts.organization_id is one
// denormalized home org; the app authorizes an account for an organization by
// an active membership row (auth.ts:396-399, and the reasoning at
// auth.ts:461-472). Reading the home org would refuse a real admin of this gym
// whose home is elsewhere and accept one whose membership here was switched
// off -- the critique's correction to the plan.
//
// THE ROLE IS THE ACCOUNT'S ROLE, pilot.accounts.role, because that is the role
// a signed-in session carries (auth.ts:373, `a.role`). "Platform owner" is
// either the role or the is_platform_owner flag: an account holding either is
// the platform owner, and gym content is never seeded by the platform owner
// (standing ruling; Jason's ACCOUNT ROLES note: Admin@ is platform_owner and is
// the weaker account for gym work).

export type DbClient = Pick<ClientBase, 'query'>;

export const GYM_CONTENT_ROLES: readonly string[] = ['organization_admin', 'admin'];

export interface ImportActor {
  accountId: string;
  /** pilot.accounts.role as stored; recorded as created_by_role / recorded_by_role. */
  role: string;
  isPlatformOwner: boolean;
}

interface AccountRow {
  account_id: string;
  role: string;
  is_platform_owner: boolean;
  active_flag: boolean;
  deleted_at: Date | string | null;
}

export async function assertImportActor(client: DbClient, organizationId: string, accountId: string): Promise<ImportActor> {
  const organization = await client.query<{ organization_id: string }>(
    'select organization_id from pilot.organizations where organization_id = $1',
    [organizationId],
  );
  if (organization.rowCount !== 1) {
    throw new ContentImportRefusal('ORGANIZATION_NOT_FOUND', `no pilot.organizations row has organization_id '${organizationId}'`);
  }

  const account = await client.query<AccountRow>(
    `select account_id, role, is_platform_owner, active_flag, deleted_at
       from pilot.accounts
      where account_id = $1`,
    [accountId],
  );
  const row = account.rows[0];
  if (!row) {
    // account_id is case-sensitive: a third casing of an email is a third
    // account (workspace DATA IDENTITY note), so say so rather than just "no".
    throw new ContentImportRefusal(
      'ACTOR_NOT_FOUND',
      `no pilot.accounts row has account_id '${accountId}'. account_id is case-sensitive; use the exact value stored.`,
    );
  }
  if (!row.active_flag) {
    throw new ContentImportRefusal('ACTOR_INACTIVE', `account '${accountId}' is inactive (active_flag false)`);
  }
  if (row.deleted_at !== null) {
    throw new ContentImportRefusal('ACTOR_DELETED', `account '${accountId}' is deleted (deleted_at is set)`);
  }

  const isPlatformOwner = row.role === 'platform_owner' || row.is_platform_owner === true;
  const actor: ImportActor = { accountId: row.account_id, role: row.role, isPlatformOwner };

  if (organizationId === PLATFORM_LIBRARY_ORGANIZATION_ID) {
    if (!isPlatformOwner) {
      throw new ContentImportRefusal(
        'ACTOR_NOT_PLATFORM_OWNER',
        `${PLATFORM_LIBRARY_ORGANIZATION_ID} is the shared platform library; only the platform owner loads it, and '${accountId}' is ${row.role}`,
      );
    }
    return actor;
  }

  if (isPlatformOwner) {
    throw new ContentImportRefusal(
      'ACTOR_PLATFORM_OWNER',
      `'${accountId}' is the platform owner. Gym content for '${organizationId}' is loaded by an organization admin of that gym, never the platform owner.`,
    );
  }
  if (!GYM_CONTENT_ROLES.includes(row.role)) {
    throw new ContentImportRefusal(
      'ACTOR_ROLE_NOT_ALLOWED',
      `'${accountId}' has role ${row.role}; gym content is loaded by ${GYM_CONTENT_ROLES.join(' or ')} only`,
    );
  }

  const membership = await client.query(
    `select 1
       from pilot.organization_memberships
      where account_id = $1 and organization_id = $2 and active_flag = true`,
    [accountId, organizationId],
  );
  if (membership.rowCount !== 1) {
    throw new ContentImportRefusal(
      'ACTOR_NOT_A_MEMBER',
      `'${accountId}' has no ACTIVE membership in '${organizationId}' (pilot.organization_memberships), so it cannot load that gym's content`,
    );
  }
  return actor;
}
