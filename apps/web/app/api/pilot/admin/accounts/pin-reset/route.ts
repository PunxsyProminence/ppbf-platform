import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { activateAccountPin, resetAccountPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireHighAssurancePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHighAssurancePrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as { account_id?: string; pin?: string; mode?: 'activate' | 'reset' };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';
    const mode = body.mode === 'activate' ? 'activate' : 'reset';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    if (mode === 'activate') {
      await activateAccountPin(accountId, pin, principal.organizationId);
    } else {
      await resetAccountPin(accountId, pin, principal.organizationId);
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: { action: mode === 'activate' ? 'pin_activate' : 'pin_reset' },
    });

    return NextResponse.json({ ok: true, account_id: accountId, mode });
  } catch (error) {
    return jsonError(error);
  }
}
