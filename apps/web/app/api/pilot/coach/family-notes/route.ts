// GET /api/pilot/coach/family-notes?athlete_id= -- what the gym posted to one
// athlete's family, and whether the family marked it done (#1542, FC-01;
// audit F-041).
//
// The coach's panel on /coach/decision-loop posts these and, before this,
// could not list them. Staff only: the coach and the organization admin, the
// same people who can post one (parentTasks.ts canSetParentTask). The athlete
// gate is assertActorCanAccessAthlete -- every athlete of the caller's own gym
// (OD-2026-10-11-007) and none of another's.
//
// Which guardian ticked a note is not returned (parentTasks.ts
// listFamilyNotesForStaff). The parent and athlete reads are untouched.
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listFamilyNotesForStaff } from '@/src/server/pilot/parentTasks';

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

    const items = await listFamilyNotesForStaff(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
