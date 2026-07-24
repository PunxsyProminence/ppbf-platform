import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { revokeAllSessionsForAccountInOrganization } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as { account_id?: string };
    const accountId = body.account_id?.trim() || '';
    if (!accountId) {
      throw new Error('Missing account_id');
    }

    // Scoped to this organization: an organization admin can never revoke a
    // user in another tenant or a platform owner.
    await revokeAllSessionsForAccountInOrganization(accountId, principal.organizationId);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: { action: 'session_revoke' },
    });

    return NextResponse.json({ ok: true, account_id: accountId });
  } catch (error) {
    return jsonError(error);
  }
}
