import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getTodaySessionNote } from '@/src/server/pilot/sessionNotes';

export const runtime = 'nodejs';

// A-FIN-08: staff read of ONE athlete's session note for today.
//
// An athlete answers "Anything your coach should know before you start?" and
// the text has been stored on pilot.sessions ever since -- but no coach
// screen has ever shown it. This route is the read that closes that, and it
// deliberately carries nothing else off the session row.
//
// WHO MAY READ (OD-2026-10-05-024 ruling 2, Jason 2026-10-05, superseding
// OD-2026-09-25-003's "any coach or admin in the organization" for this
// read): the athlete's coach of record, a coach holding a live coverage
// grant, or an organization admin -- assertActorCanAccessAthlete.
//
// WHY THIS IS NOT /api/pilot/sessions/list. That route returns the whole
// session record -- RPE, completion state and every other column. This route
// carries the note and nothing else off the row.
//
// SOFT-DELETED AND CROSS-ORGANIZATION ATHLETES: the shared gate refuses both
// with the same message it gives "not your athlete", so a refusal tells the
// caller nothing about whether the id names a real child.
//
// TWO GATES, IN ORDER. The role list says a staff member may read session
// notes; it does not say WHOSE. athlete_id is caller-supplied, so the
// athlete gate answers that second question -- including whether the
// athlete is still live -- before any session row is read. The organization
// is always the authenticated principal's own: there is no organization_id
// parameter here, by design, so a query string cannot aim this at another gym.
//
// NOTHING DERIVED, AND NO AUTHOR. The response is { today: null } or
// { today: { note } } and carries no RPE, no readiness, no completion score
// and no author id. The row records no author or last editor -- a coach or
// admin can currently update it through /sessions/update -- so inventing one
// here would be a claim the database cannot support. The screen says so in
// words rather than naming anybody.
//
// SYSTEM TEXT IS ALREADY GONE by the time it reaches here: getTodaySessionNote
// turns the A-FIN-01 placeholder and the historical "Auto check-in readiness"
// rows into note: null server-side. The coach screen filters them again.

const SESSION_NOTE_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SESSION_NOTE_READ_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    // { today: null } is a successful answer -- "checked, no session started
    // today at the gym" -- not a missing resource. The coach screen depends on
    // that to keep "no session today" apart from "could not read", which are
    // different things to tell someone standing in front of a child.
    const today = await getTodaySessionNote(principal.organizationId, athleteId);
    return NextResponse.json({ today });
  } catch (error) {
    return jsonError(error);
  }
}
