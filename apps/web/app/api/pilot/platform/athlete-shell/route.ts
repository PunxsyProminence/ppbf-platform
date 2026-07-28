import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { createAthleteAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Platform-scoped parallel to POST /api/pilot/admin/athlete-accounts, for any
 * organization by explicit organization_id rather than the caller's own.
 *
 * This creates a login-account SHELL only: it links account_id to an
 * already-existing pilot.athletes roster row with no PIN and active_flag
 * false -- it grants no sign-in capability. Deliberately, this route does not
 * and must never issue an activation code: that is the one step platform_owner
 * is permanently excluded from (see activation-codes/route.ts), because a
 * minted code lets whoever holds it set the athlete's PIN and sign in as them.
 * Completing activation stays the job of that gym's own admin, via the
 * existing /admin/people flow -- this route's response says so explicitly.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      account_id?: string;
      athlete_id?: string;
    };

    const organizationId = body.organization_id?.trim() || '';
    const accountId = body.account_id?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';

    if (!organizationId || !accountId || !athleteId) {
      throw new Error('Missing organization_id, account_id, or athlete_id');
    }

    await createAthleteAccount(accountId, athleteId, organizationId);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'athlete_account',
      entity_id: accountId,
      details: { athlete_id: athleteId, account_state: 'pending_pin_activation', action: 'platform_owner_prepare_athlete_shell' },
    });

    return NextResponse.json({
      ok: true,
      account_id: accountId,
      athlete_id: athleteId,
      organization_id: organizationId,
      account_state: 'pending_pin_activation',
      next_step: "This gym's own admin must issue an activation code in Admin > People before this athlete can sign in.",
    });
  } catch (error) {
    return jsonError(error);
  }
}
