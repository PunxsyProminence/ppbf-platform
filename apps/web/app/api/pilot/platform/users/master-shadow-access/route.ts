import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { setAccountMasterShadowAccess } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Grant/revoke path for has_master_shadow_access -- the standing
// cross-organization privilege flag. Gated at the same bar this codebase
// already uses for its other platform-level cross-org grants (assign-admin,
// transfer-admin, organizations/status, users/status): platform_owner only.
// There is no broader existing precedent for a comparably powerful
// cross-org grant, so this does not invent a lower bar.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      account_id?: string;
      granted?: boolean;
    };

    const accountId = body.account_id?.trim() || '';

    if (!accountId || typeof body.granted !== 'boolean') {
      throw new Error('Missing account_id or granted');
    }

    const result = await setAccountMasterShadowAccess(accountId, body.granted);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: result.organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: body.granted ? 'grant_master_shadow_access' : 'revoke_master_shadow_access',
        has_master_shadow_access: result.hasMasterShadowAccess,
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: result.accountId,
      role: result.role,
      has_master_shadow_access: result.hasMasterShadowAccess,
    });
  } catch (error) {
    return jsonError(error);
  }
}
