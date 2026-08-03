import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { createAthleteAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    // Athlete credentials sit outside the platform-owner tier, the same
    // boundary session revocation and PIN reset hold: Omega gathers data and
    // supports organization admins rather than holding the keys to a child's
    // account. This route returns every athlete's name in the organization,
    // which is precisely what access.ts refuses that role everywhere else.
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
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

    const { startingPin } = await createAthleteAccount(accountId, athleteId, principal.organizationId);

    // The PIN is deliberately absent from the audit details. It is a live
    // credential for a child's account until they replace it, and audit rows are
    // mirrored into SHADOW's event stream and readable long after the fact --
    // the same reason correction audits store field names and never values.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete_account',
      entity_id: accountId,
      details: { athlete_id: athleteId, account_state: 'pending_pin_activation' },
    });

    // starting_pin is returned exactly once, to the admin who just created the
    // account, and is not recoverable afterwards -- it is hashed in the database.
    // If it is lost before it reaches the athlete, the fix is a PIN reset, which
    // issues a fresh one.
    return NextResponse.json({
      ok: true,
      account_id: accountId,
      athlete_id: athleteId,
      account_state: 'pending_pin_activation',
      starting_pin: startingPin,
    });
  } catch (error) {
    return jsonError(error);
  }
}
