import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getAccountRoleInOrganization, setAccountActiveStatus } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * The roles an organization admin may deactivate or reactivate in their own
 * gym. Owner ruling (Jason 2026-10-07, OD-2026-10-07-009, question card 2,
 * "Yes, org admin can"): a departed coach, staff member or volunteer.
 *
 * Everything else is refused by name below, each for its own reason:
 *   organization_admin / admin  -- a peer; an admin who could switch off the
 *                                  other admins would hold the gym alone.
 *   platform_owner              -- outside the gym's authority altogether.
 *   athlete                     -- a child's login is administered through the
 *                                  roster and the PIN controls, not switched
 *                                  off here; setAccountActiveStatus would also
 *                                  end their sessions.
 *   parent                      -- a guardian's standing over a child is a
 *                                  guardian link, not a staff account; removing
 *                                  it is the people console's link controls.
 *   board                       -- a seat, not staff (boardSeats.ts).
 *   self                        -- refused before the role is even read.
 */
export const DEACTIVATABLE_ROLES: readonly PilotRole[] = ['coach', 'staff', 'volunteer'];

/**
 * Switch a coach, staff or volunteer account in the caller's organization off
 * or back on.
 *
 * ONE ROUTE FOR BOTH DIRECTIONS, like the platform tier's users/status: the
 * body carries `active_flag`, required and a real boolean, so a missing or
 * stringly value is a 400 and never read as "deactivate".
 *
 * WHAT DEACTIVATION DOES (auth.ts setAccountActiveStatus): clears active_flag
 * on pilot.accounts and the organization membership in one transaction and
 * revokes every session the account holds, so a departed coach is signed out
 * now and cannot sign back in. The credential is not destroyed; reactivation
 * restores sign-in with nothing else changed. A deleted login is changed in
 * neither direction (OD-2026-09-30-004 e2) and surfaces as the helper's own
 * refusal.
 *
 * TENANCY. The organization is the session's, never the body's. The target's
 * role is read in THAT organization (getAccountRoleInOrganization), so an
 * account in another gym resolves to no role and is refused as not found
 * before anything is written -- the same shape accounts/revoke takes.
 *
 * MICROSOFT SESSION REQUIRED, as for every account-management route here: a
 * PIN or emailed-link session cannot switch another person's account off.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin']);

    const body = (await request.json().catch(() => null)) as
      | { account_id?: unknown; active_flag?: unknown }
      | null;
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    if (!accountId) {
      throw new Error('Missing account_id');
    }
    if (typeof body?.active_flag !== 'boolean') {
      throw new Error('Missing active_flag: must be true (reactivate) or false (deactivate)');
    }
    const activeFlag = body.active_flag;

    // Refused before the role read: the caller's own row would pass the role
    // test only if an admin were somehow a coach, and the answer is no either way.
    if (accountId === principal.accountId) {
      throw new Error('Forbidden: you cannot deactivate or reactivate your own account');
    }

    const targetRole = await getAccountRoleInOrganization(accountId, principal.organizationId);
    if (!targetRole) {
      throw new Error('Not found: no account with that id in your organization');
    }
    if (!DEACTIVATABLE_ROLES.includes(targetRole)) {
      throw new Error(
        `Forbidden: an organization admin can deactivate coach, staff or volunteer accounts only; this account is ${targetRole}`,
      );
    }

    await setAccountActiveStatus(accountId, principal.organizationId, activeFlag);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: activeFlag ? 'organization_admin_reactivate_account' : 'organization_admin_deactivate_account',
        active_flag: activeFlag,
        target_role: targetRole,
      },
    });

    return NextResponse.json({ ok: true, account_id: accountId, active_flag: activeFlag, role: targetRole });
  } catch (error) {
    return jsonError(error);
  }
}
