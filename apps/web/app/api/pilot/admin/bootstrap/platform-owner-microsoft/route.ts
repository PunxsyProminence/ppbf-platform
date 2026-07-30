import { NextResponse, type NextRequest } from 'next/server';

import {
  createOrUpdateMicrosoftPlatformOwnerAccount,
  createOrganization,
} from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const PRIMARY_OWNER_EMAIL = 'Admin@punxsyprominence.org';
const ROOT_ORG_NAME = 'PPBF Root Platform Organization';

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

    const body = (await request.json().catch(() => ({}))) as {
      organization_id?: string;
      organization_name?: string;
    };

    const organizationId = body.organization_id?.trim() || getPilotDefaultOrganizationId();
    const organizationName = body.organization_name?.trim() || ROOT_ORG_NAME;

    await createOrganization(organizationId, organizationName, PRIMARY_OWNER_EMAIL.toLowerCase());

    const result = await createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: PRIMARY_OWNER_EMAIL,
      organizationId,
      accountIdHint: PRIMARY_OWNER_EMAIL.toLowerCase(),
    });

    await writePilotAuditEvent({
      event_type: result.created ? 'create' : 'update',
      actor_account_id: result.accountId,
      actor_role: 'platform_owner',
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: result.accountId,
      details: {
        action: 'bootstrap_platform_owner_microsoft',
        login_email: PRIMARY_OWNER_EMAIL,
        auth_provider: 'microsoft',
        pin_hash: null,
      },
    });

    return NextResponse.json({
      ok: true,
      action: result.created ? 'created' : 'updated',
      account_id: result.accountId,
      login_email: PRIMARY_OWNER_EMAIL,
      auth_provider: 'microsoft',
      role: 'platform_owner',
      organization_id: organizationId,
      active_flag: true,
      pin_hash: null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
