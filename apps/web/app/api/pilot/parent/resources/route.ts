// GET /api/pilot/parent/resources?athlete_id= -- the guides, checklists,
// videos and policies the gym has published for this child's family
// (#1593, PH-11).
//
// Parent only. The child must be linked to this guardian on this request
// (linked, not deleted, under 18); anything else is the same 404. The gym
// comes from the session. Published resources for every family plus those
// for a program the child is an active member of; an internal link only to a
// page a parent can open (parentResources.ts). Read only: nothing is sent.
import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { listResourcesForGuardian } from '@/src/server/pilot/parentResources';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new Error('Missing athlete_id');

    const items = await listResourcesForGuardian(principal.organizationId, principal.accountId, athleteId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}
