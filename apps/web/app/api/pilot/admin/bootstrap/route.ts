import { NextResponse, type NextRequest } from 'next/server';

import { createOrRotateAdminAccount, createOrganization, assignOrganizationMembership } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY?.trim() || '';
    const providedKey = request.headers.get('x-ppbf-bootstrap-key')?.trim() || '';

    if (!bootstrapKey) {
      throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
    }

    if (!providedKey || providedKey !== bootstrapKey) {
      throw new Error('Forbidden: invalid bootstrap key');
    }

    const body = (await request.json()) as {
      account_id?: string;
      pin?: string;
      organization_id?: string;
      organization_name?: string;
      bootstrap_role?: 'organization_admin' | 'platform_owner';
    };
    const accountId = body.account_id?.trim() || '';
    const pin = body.pin?.trim() || '';
    const organizationId = body.organization_id?.trim() || getPilotDefaultOrganizationId();
    const organizationName = body.organization_name?.trim() || 'PPBF Default Organization';
    const bootstrapRole = body.bootstrap_role === 'platform_owner' ? 'platform_owner' : 'organization_admin';

    if (!accountId || !pin) {
      throw new Error('Missing account_id or pin');
    }

    await createOrganization(organizationId, organizationName, accountId);
    await createOrRotateAdminAccount(accountId, pin, organizationId, bootstrapRole);
    await assignOrganizationMembership(accountId, organizationId, bootstrapRole);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: accountId,
      actor_role: bootstrapRole,
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: { action: 'bootstrap_admin', organization_id: organizationId, organization_name: organizationName },
    });

    return NextResponse.json({ ok: true, account_id: accountId, organization_id: organizationId, role: bootstrapRole });
  } catch (error) {
    return jsonError(error);
  }
}
