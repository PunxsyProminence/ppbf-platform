import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { createAthleteAccountPendingActivation } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const SUPPORTED_CREATE_ROLES: PilotRole[] = ['athlete'];

function assertSupportedCreateRole(role: string): role is 'athlete' {
  return SUPPORTED_CREATE_ROLES.includes(role as PilotRole);
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    // Athlete credentials sit outside the platform-owner tier, the same
    // boundary session revocation, PIN reset and the PIN directory hold: Omega
    // gathers data and supports organization admins rather than holding the
    // keys to a child's account.
    //
    // This route admitted only the platform owner, and `organization_id` comes
    // from the request body rather than the session -- so the one role the rule
    // excludes was the only role that could reach it, in any gym it named.
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as {
      organization_id?: string;
      account_id?: string;
      role?: string;
      pin?: string;
      athlete_id?: string;
    };

    // The gym comes from the session, never from the request. A body-supplied
    // organization_id is how this route reached across gyms; an admin acts in
    // their own gym and nowhere else. A caller naming a different one is
    // refused rather than silently redirected, so a wrong integration fails
    // loudly instead of writing somewhere unexpected.
    const organizationId = principal.organizationId;
    const requestedOrganizationId = body.organization_id?.trim() || '';
    if (requestedOrganizationId && requestedOrganizationId !== organizationId) {
      throw new Error('Forbidden: organization_id does not match the session');
    }

    const accountId = body.account_id?.trim() || '';
    const role = body.role?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';

    if (!accountId || !role) {
      throw new Error('Missing account_id or role');
    }

    if (!assertSupportedCreateRole(role)) {
      throw new Error('Unsupported role: privileged accounts must be Microsoft-authenticated');
    }

    if (!athleteId) {
      throw new Error('Missing athlete_id for athlete role');
    }

    // Create-only. The upsert this used to call nulls pin_hash, clears
    // active_flag and revokes every session when the account already exists --
    // so a replayed request locked a child out of their own account. Issuing
    // new credentials to an existing athlete is the PIN reset console's job,
    // and it says so.
    await createAthleteAccountPendingActivation(accountId, athleteId, organizationId);

    // Each of the create/rotate functions above already assigns the
    // matching organization membership atomically alongside the account
    // upsert.

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: 'platform_owner_create_user',
        role,
        athlete_id: athleteId || null,
        account_state: 'pending_pin_activation',
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: accountId,
      organization_id: organizationId,
      role,
      athlete_id: athleteId || null,
      account_state: 'pending_pin_activation',
    });
  } catch (error) {
    return jsonError(error);
  }
}
