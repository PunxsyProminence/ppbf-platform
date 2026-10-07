import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { COMPETITION_READ_ROLES, listAthleteCompetitionHistory } from '@/src/server/pilot/externalCompetition';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Map item 10: ONE athlete's bout history -- their external-competition
// entries with result and lesson note -- for the coach's selected-athlete
// view. Read only.
//
// Roles are COMPETITION_READ_ROLES. The athlete role is NOT in it, and this
// route does not add it: an athlete reading their own record would be a new
// permission, not this item.
//
// WHOSE (OD-2026-10-05-024 ruling 2): assertActorCanAccessAthlete -- the
// athlete's coach of record, a covering coach with a live grant, or an
// organization admin. It refuses another gym's athlete and a soft-deleted one
// with a 403 before the history is read; the query itself also requires a
// live athlete. The organization is the session's.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COMPETITION_READ_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listAthleteCompetitionHistory(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
