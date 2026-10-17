// GET /api/pilot/athlete/coach-messages -- what the athlete's coaches wrote to
// them (#1542, FC-06). The athlete only, for their own record: the athlete id
// comes from the session, never from the request. Read only; the athlete
// replies by talking to their coach (FC-06 Q-4 default A).
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { listAthleteCoachMessages } from '@/src/server/pilot/athleteCoachMessages';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);

    const athleteId = principal.athleteId?.trim() ?? '';
    if (!athleteId) {
      throw new Error('Forbidden: this account is not linked to an athlete');
    }
    // The same athlete gate every athlete read uses: their own, in their gym,
    // and not a deleted record.
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listAthleteCoachMessages(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}
