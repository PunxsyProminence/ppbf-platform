import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { transferOrganizationAdmin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const DEMOTE_ROLES: PilotRole[] = ['coach', 'athlete', 'parent', 'volunteer', 'staff', 'admin'];

function isSupportedDemoteRole(role: string): role is Exclude<PilotRole, 'platform_owner' | 'organization_admin'> {
  return DEMOTE_ROLES.includes(role as PilotRole);
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      from_account_id?: string;
      to_account_id?: string;
      demote_role?: string;
    };

    const organizationId = body.organization_id?.trim() || '';
    const fromAccountId = body.from_account_id?.trim() || '';
    const toAccountId = body.to_account_id?.trim() || '';
    const demoteRole = body.demote_role?.trim() || 'coach';

    if (!organizationId || !fromAccountId || !toAccountId) {
      throw new Error('Missing organization_id, from_account_id, or to_account_id');
    }

    if (!isSupportedDemoteRole(demoteRole)) {
      throw new Error('Unsupported demote_role');
    }

    await transferOrganizationAdmin(fromAccountId, toAccountId, organizationId, demoteRole);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'organization_membership',
      entity_id: `${organizationId}:${fromAccountId}->${toAccountId}`,
      details: {
        action: 'transfer_organization_admin',
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        demote_role: demoteRole,
      },
    });

    return NextResponse.json({
      ok: true,
      organization_id: organizationId,
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      demote_role: demoteRole,
      new_role: 'organization_admin',
    });
  } catch (error) {
    return jsonError(error);
  }
}
