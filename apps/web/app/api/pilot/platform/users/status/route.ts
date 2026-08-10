import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getAccountRoleInOrganization, setAccountActiveStatus } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      account_id?: string;
      active_flag?: boolean;
    };

    const organizationId = body.organization_id?.trim() || '';
    const accountId = body.account_id?.trim() || '';

    if (!organizationId || !accountId || typeof body.active_flag !== 'boolean') {
      throw new Error('Missing organization_id, account_id, or active_flag');
    }

    // Suspending a gym's staff account is legitimate platform operation -- a
    // compromised admin has to be stoppable from outside the gym. A child is
    // not. setAccountActiveStatus revokes every session for the account, and
    // session revocation for an athlete belongs to that gym's own admin, the
    // same boundary the PIN directory, PIN reset and revoke routes hold.
    //
    // Scoped deliberately narrowly: this refuses athletes, not the route.
    const targetRole = await getAccountRoleInOrganization(accountId, organizationId);
    if (targetRole === 'athlete') {
      throw new Error(
        'Forbidden: an athlete account is administered by their own gym',
      );
    }

    await setAccountActiveStatus(accountId, organizationId, body.active_flag);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: body.active_flag ? 'reactivate_user' : 'disable_user',
        active_flag: body.active_flag,
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: accountId,
      organization_id: organizationId,
      active_flag: body.active_flag,
    });
  } catch (error) {
    return jsonError(error);
  }
}
