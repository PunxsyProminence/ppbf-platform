import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { setOrganizationStatus } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      status?: 'active' | 'inactive' | 'suspended' | 'pending';
    };

    const organizationId = body.organization_id?.trim() || '';
    const status = body.status;

    if (!organizationId || !status) {
      throw new Error('Missing organization_id or status');
    }

    if (!['active', 'inactive', 'suspended', 'pending'].includes(status)) {
      throw new Error('Unsupported status');
    }

    await setOrganizationStatus(organizationId, status);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'organization',
      entity_id: organizationId,
      details: { status },
    });

    return NextResponse.json({ ok: true, organization_id: organizationId, status });
  } catch (error) {
    return jsonError(error);
  }
}
