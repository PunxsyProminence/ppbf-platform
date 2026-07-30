import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { promoteAccountToOrganizationAdmin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      account_id?: string;
      organization_id?: string;
    };

    const accountId = body.account_id?.trim() || '';
    const organizationId = body.organization_id?.trim() || '';

    if (!accountId || !organizationId) {
      throw new Error('Missing account_id or organization_id');
    }

    await promoteAccountToOrganizationAdmin(accountId, organizationId);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'organization_membership',
      entity_id: `${organizationId}:${accountId}`,
      details: { account_id: accountId, organization_id: organizationId, role: 'organization_admin' },
    });

    return NextResponse.json({ ok: true, account_id: accountId, organization_id: organizationId, role: 'organization_admin' });
  } catch (error) {
    return jsonError(error);
  }
}
