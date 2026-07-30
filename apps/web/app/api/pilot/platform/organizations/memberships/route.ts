import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { upsertOrganizationMembership } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const MANAGEABLE_ROLES: PilotRole[] = ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'];

function isManageableRole(role: string): role is Exclude<PilotRole, 'platform_owner'> {
  return MANAGEABLE_ROLES.includes(role as PilotRole);
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      account_id?: string;
      role?: string;
      active_flag?: boolean;
    };

    const organizationId = body.organization_id?.trim() || '';
    const accountId = body.account_id?.trim() || '';
    const role = body.role?.trim() || '';
    const activeFlag = body.active_flag;

    if (!organizationId || !accountId || !role || typeof activeFlag !== 'boolean') {
      throw new Error('Missing organization_id, account_id, role, or active_flag');
    }

    if (!isManageableRole(role)) {
      throw new Error('Unsupported role');
    }

    await upsertOrganizationMembership(accountId, organizationId, role, activeFlag);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'organization_membership',
      entity_id: `${organizationId}:${accountId}`,
      details: {
        action: 'manage_organization_membership',
        role,
        active_flag: activeFlag,
      },
    });

    return NextResponse.json({
      ok: true,
      organization_id: organizationId,
      account_id: accountId,
      role,
      active_flag: activeFlag,
    });
  } catch (error) {
    return jsonError(error);
  }
}
