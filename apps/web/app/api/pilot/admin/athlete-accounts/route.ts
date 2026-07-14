import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { createAthleteAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin']);

    const body = (await request.json()) as {
      account_id?: string;
      athlete_id?: string;
      pin?: string;
    };

    const accountId = body.account_id?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';
    const pin = body.pin?.trim() || '';

    if (!accountId || !athleteId || !pin) {
      throw new Error('Missing account_id, athlete_id, or pin');
    }

    await createAthleteAccount(accountId, athleteId, pin);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'athlete_account',
      entity_id: accountId,
      details: { athlete_id: athleteId },
    });

    return NextResponse.json({ ok: true, account_id: accountId, athlete_id: athleteId });
  } catch (error) {
    return jsonError(error);
  }
}
