import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';

// Roles that can be provisioned as a Microsoft-authenticated account through
// this module.
//
// Deliberately excluded:
//   platform_owner -- provisioned only by the dedicated bootstrap path, which
//                     pins the identity to PPBF_PRIMARY_OWNER_EMAIL. Allowing
//                     it here would let any org-scoped invite escalate to
//                     full platform ownership.
//   athlete        -- athletes authenticate by PIN and are provisioned through
//                     the activation-code flow. Giving an athlete a Microsoft
//                     login would bypass the athlete-only PIN boundary.
//   admin          -- legacy alias retained for existing rows only; new
//                     accounts use organization_admin.
export const INVITABLE_STAFF_ROLES = [
  'organization_admin',
  'coach',
  'board',
  'staff',
  'volunteer',
  'parent',
] as const;

export type InvitableStaffRole = (typeof INVITABLE_STAFF_ROLES)[number];

// Roles an organization_admin may invite within their own organization. They
// cannot mint another organization_admin -- that is a platform_owner action,
// so an org admin can never unilaterally expand the set of people who share
// their authority.
export const ORG_ADMIN_INVITABLE_ROLES: InvitableStaffRole[] = ['coach', 'staff', 'volunteer', 'parent'];

export function isInvitableStaffRole(role: string): role is InvitableStaffRole {
  return (INVITABLE_STAFF_ROLES as readonly string[]).includes(role);
}

export interface StaffProvisionResult {
  accountId: string;
  organizationId: string;
  role: InvitableStaffRole;
  loginEmail: string;
  created: boolean;
}

export interface OrganizationMember {
  account_id: string;
  login_email: string | null;
  auth_provider: 'ppbf_local' | 'microsoft';
  role: PilotRole;
  athlete_id: string | null;
  active_flag: boolean;
  has_pin: boolean;
  membership_active: boolean;
  created_at: string;
  updated_at: string;
}

function normalizeEmail(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Missing login_email');
  }

  // Deliberately permissive but structural: exactly one @, non-empty local
  // part, and a dotted domain. This is an identity mapping key, not a
  // deliverability check -- there is no mail being sent.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalized)) {
    throw new Error('Missing login_email: value is not a valid email address');
  }

  return normalized;
}

/**
 * Creates or updates a Microsoft-authenticated staff account and its
 * organization membership.
 *
 * This is the only path by which a coach, organization admin, board member,
 * or other non-athlete role can obtain a working login. Microsoft sign-in
 * resolves an identity purely by `lower(login_email)` + `auth_provider =
 * 'microsoft'`, so an account row written here is what makes an invited
 * person's Entra identity map onto a PPBF role.
 *
 * Provisioning a row here does NOT by itself let someone in: the Microsoft
 * token must still carry the configured tenant claim, so the invitee must
 * also exist in the PPBF Entra tenant (as a member or a B2B guest).
 */
export async function createOrUpdateMicrosoftStaffAccount(params: {
  loginEmail: string;
  organizationId: string;
  role: InvitableStaffRole;
  accountIdHint?: string;
}): Promise<StaffProvisionResult> {
  const loginEmail = normalizeEmail(params.loginEmail);
  const organizationId = params.organizationId.trim();
  const role = params.role;

  if (!organizationId) {
    throw new Error('Missing organization_id');
  }

  // Defense in depth: the type already excludes these, but this module is the
  // privilege boundary, so it re-checks rather than trusting its caller.
  if (!isInvitableStaffRole(role)) {
    throw new Error('Unsupported role');
  }

  const organization = await queryOne<{ organization_id: string }>(
    'select organization_id from pilot.organizations where organization_id = $1',
    [organizationId],
  );

  if (!organization) {
    throw new Error('Missing organization_id: organization does not exist');
  }

  const existing = await queryOne<{
    account_id: string;
    organization_id: string | null;
    role: PilotRole;
    auth_provider: 'ppbf_local' | 'microsoft';
    is_platform_owner: boolean;
  }>(
    `select account_id, organization_id, role, auth_provider, is_platform_owner
     from pilot.accounts
     where lower(login_email) = $1`,
    [loginEmail],
  );

  if (existing) {
    // Never let an org-scoped invite touch the platform owner's account. That
    // account is managed solely by the bootstrap path.
    if (existing.is_platform_owner || existing.role === 'platform_owner') {
      throw new Error('Forbidden: cannot modify a platform owner account');
    }

    // Cross-organization takeover guard, matching the athlete create path: an
    // identity already provisioned in one organization cannot be silently
    // re-pointed at another by whoever invites that email next.
    if (existing.organization_id && existing.organization_id !== organizationId) {
      throw new Error('Forbidden: account already exists in another organization');
    }

    // An athlete authenticates by PIN. Converting that row to a Microsoft
    // staff account would clear the PIN and strand the athlete, and would
    // move an athlete-scoped record (athlete_id, session history) onto a
    // privileged role. Require the athlete account be handled explicitly
    // instead of mutating it as a side effect of an invite.
    if (existing.role === 'athlete' || existing.auth_provider === 'ppbf_local') {
      throw new Error('Forbidden: this email is already used by a PIN-based athlete account');
    }
  }

  const accountId = existing?.account_id || params.accountIdHint?.trim() || loginEmail;

  if (!existing) {
    // The account_id is a separate primary key from the email. If the caller
    // supplied a hint that collides with an unrelated account, fail rather
    // than overwrite that account's role and organization.
    const accountIdCollision = await queryOne<{ account_id: string }>(
      'select account_id from pilot.accounts where account_id = $1',
      [accountId],
    );

    if (accountIdCollision) {
      throw new Error('Forbidden: account_id is already in use by another identity');
    }
  }

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
       values ($1, $2, 'microsoft', $3, $4, false, null, null, true)
       on conflict (account_id) do update set
         login_email = excluded.login_email,
         auth_provider = 'microsoft',
         role = excluded.role,
         organization_id = excluded.organization_id,
         is_platform_owner = false,
         athlete_id = null,
         pin_hash = null,
         active_flag = true,
         updated_at = now()`,
      [accountId, loginEmail, role, organizationId],
    );

    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, true)
       on conflict (account_id, organization_id) do update
         set role = excluded.role,
             active_flag = true,
             updated_at = now()`,
      [accountId, organizationId, role],
    );

    if (existing) {
      // Role or organization may have just changed. resolvePrincipal reads
      // pilot.accounts.role live on every request, so any session minted
      // under the previous configuration must not survive this write.
      await client.query(
        'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
        [accountId],
      );
    }
  });

  return {
    accountId,
    organizationId,
    role,
    loginEmail,
    created: !existing,
  };
}

/**
 * Lists every account holding a membership in an organization, with enough
 * status detail for the admin people console to show who can actually sign in.
 *
 * `has_pin` is a boolean derived from pin_hash -- the hash itself never leaves
 * the database.
 */
export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
  return query<OrganizationMember>(
    `select
       a.account_id,
       a.login_email,
       a.auth_provider,
       om.role,
       a.athlete_id,
       a.active_flag,
       (a.pin_hash is not null) as has_pin,
       om.active_flag as membership_active,
       a.created_at,
       a.updated_at
     from pilot.organization_memberships om
     join pilot.accounts a on a.account_id = om.account_id
     where om.organization_id = $1
     order by
       case om.role
         when 'organization_admin' then 1
         when 'admin' then 2
         when 'coach' then 3
         when 'board' then 4
         when 'staff' then 5
         when 'volunteer' then 6
         when 'parent' then 7
         else 8
       end,
       a.account_id asc`,
    [organizationId],
  );
}
