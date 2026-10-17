// GET /api/pilot/coach/athlete-messages?athlete_id= -- what the gym's staff
// wrote to one athlete (#1542, FC-06), for the coach's "Sent to this athlete"
// list on /coach/decision-loop: so a coach can see a message landed (instead
// of sending it twice) and the gym has a record of what was written to a child.
//
// Staff only, the same people and athlete gate as /api/pilot/coach/family-notes:
// coach, organization admin and admin, and assertActorCanAccessAthlete -- every
// athlete of the caller's own gym and none of another's. Same rows the athlete
// reads (athleteCoachMessages.ts): staff-written only, no account id.
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listAthleteCoachMessages } from '@/src/server/pilot/athleteCoachMessages';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athleteId = new URL(request.url).searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listAthleteCoachMessages(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
