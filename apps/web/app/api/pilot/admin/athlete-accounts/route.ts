import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { createAthleteAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin', 'platform_owner']);
    if (!isOrganizationAdminRole(principal.role) && principal.role !== 'platform_owner') {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as {
      account_id?: string;
      athlete_id?: string;
    };

    const accountId = body.account_id?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';

    if (!accountId || !athleteId) {
      throw new Error('Missing account_id or athlete_id');
    }

    await createAthleteAccount(accountId, athleteId, principal.organizationId);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete_account',
      entity_id: accountId,
      details: { athlete_id: athleteId, account_state: 'pending_pin_activation' },
    });

    return NextResponse.json({ ok: true, account_id: accountId, athlete_id: athleteId, account_state: 'pending_pin_activation' });
  } catch (error) {
    return jsonError(error);
  }
}
