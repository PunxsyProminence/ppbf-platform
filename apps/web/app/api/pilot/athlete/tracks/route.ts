import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { readAthleteTracks } from '@/src/server/pilot/trackAssignments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tracks the signed-in athlete is on (OD-2026-10-07-010 ruling 3: tracks
 * are assigned to real athletes and shown on the athlete's Tracks tab).
 *
 * OWN RECORD ONLY. Athlete role, and the subject comes from the session -- an
 * `athlete_id` query parameter is never read, so there is no parameter to get
 * wrong. Coaches, parents and admins are not served here; the gym's admins
 * read and set tracks on /api/pilot/admin/track-assignments.
 *
 * READ-ONLY. `tracks` is a list of track ids, empty when none is assigned.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);

    const athleteId = principal.athleteId;
    if (!athleteId) {
      throw new ValidationError('This account is not linked to an athlete record.', 'ATHLETE_RECORD_NOT_LINKED');
    }
    // The athlete's row must still be live in their own gym: a session that
    // outlived the athlete's deletion carries the same id.
    await assertActorCanAccessAthlete(principal, athleteId);

    return NextResponse.json({ tracks: await readAthleteTracks(principal.organizationId, athleteId) });
  } catch (error) {
    return jsonError(error);
  }
}
