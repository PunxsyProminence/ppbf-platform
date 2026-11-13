import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getClassPlanTrack, listClassPlanTracks } from '@/src/server/pilot/classPlans';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Read-only "Class plans" (OD-2026-11-12-005): the gym's training tracks.
// GET lists them; GET ?track=<track_id> returns one with its weeks and days.
//
// WHO: coaches and gym admins only, the issue route's list (OD-2026-11-12-005
// ruling 2: "coaches and gym admins only"). Deliberately NOT the wider
// COACHING_CONTENT_READER_ROLES the templates read admits: athletes, parents,
// volunteers and staff do not read the plan, and platform_owner cannot reach
// an organization's private records by default. The gate sits above the query
// parse. A track names no athlete; the reads take the principal's
// organization and accept no other.
const CLASS_PLAN_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CLASS_PLAN_ROLES]);

    const trackId = new URL(request.url).searchParams.get('track');
    if (trackId) {
      const track = await getClassPlanTrack(principal.organizationId, trackId);
      if (!track) {
        return NextResponse.json({ error: 'TRAINING_TRACK_NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json({ track });
    }
    return NextResponse.json({ tracks: await listClassPlanTracks(principal.organizationId) });
  } catch (error) {
    return jsonError(error);
  }
}
