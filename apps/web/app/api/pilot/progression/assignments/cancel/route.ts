import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { cancelDrillAssignment, getDrillAssignmentById } from '@/src/server/pilot/progression';
import { hiddenNotFound, jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/*
  POST /api/pilot/progression/assignments/cancel -- A-FIN-06.

  A coach takes back work an athlete is still expected to do. One action, one
  route: this is deliberately NOT a status PATCH on the assignment. A generic
  status write would be an edit endpoint with one allowed value today and a
  second one the day somebody widens the check; a route that can only cancel
  cannot be talked into anything else. Owner decisions 2026-09-22: cancel only
  -- no edit, no delete, no undo or reopen -- and only open work ('assigned' or
  'in_progress'). The transition rules and the history guarantee live in
  cancelDrillAssignment (progression.ts); this route decides who may ask.

  WHO MAY CANCEL (owner decision, "Coaches with access"): the same people who
  can assign work to this athlete today -- the coach of record, a coach with a
  live coverage grant, an organization admin. That is requireRole plus
  assertActorCanAccessAthlete, exactly the pair assignments POST uses. No new
  permission model.

  ORDER, AND WHY IT IS THIS ORDER.
    1. Role. Athletes, parents, board and platform_owner are refused before
       anything is read -- a role refusal says nothing about any record.
    2. The assignment is resolved inside the caller's own organization. The
       organization is the session's and is never read from the body, so
       another gym's assignment id is simply absent here.
    3. The request's athlete_id must be the assignment's own. A mismatch fails
       closed, as not found: answering anything else would confirm that the
       assignment exists under some other athlete.
    4. Access to that athlete. A refusal here is ALSO rendered as not found,
       as completions GET does, so a coach in the same gym cannot probe which
       assignment ids exist for athletes they cannot reach. Only a refusal is
       folded in: any other failure (a database error) still reaches jsonError
       as a 500, because a failed check is not an answer of "no such record".
  Only then is anything written, and the write re-checks organization, id and
  athlete itself.

  No audit event is written: no progression route writes one today, and a new
  event type needs a migration. Recorded as an open question with the slice.
*/

/** A non-empty string id, passed through untouched; anything else is absent. */
function requiredId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    // An unparseable body is the caller's mistake, not a server fault, so it
    // is a 400 rather than falling through to the generic 500.
    const body = (await request.json().catch(() => null)) as {
      assignment_id?: unknown;
      athlete_id?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      throw new Error('Request body must be a JSON object');
    }

    const assignmentId = requiredId(body.assignment_id);
    const athleteId = requiredId(body.athlete_id);
    if (!assignmentId || !athleteId) {
      throw new Error('Missing assignment_id or athlete_id');
    }

    const assignment = await getDrillAssignmentById(principal.organizationId, assignmentId);
    if (!assignment || assignment.athlete_id !== athleteId) {
      return hiddenNotFound();
    }

    try {
      await assertActorCanAccessAthlete(principal, assignment.athlete_id);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Forbidden')) {
        return hiddenNotFound();
      }
      throw error;
    }

    const result = await cancelDrillAssignment({
      organizationId: principal.organizationId,
      assignmentId,
      athleteId: assignment.athlete_id,
    });

    // The row was there a moment ago and is gone now -- deleted between the
    // read and the write. Same answer as never having been there.
    if (!result) {
      return hiddenNotFound();
    }

    return NextResponse.json({
      assignment: result.assignment,
      already_cancelled: result.alreadyCancelled,
    });
  } catch (error) {
    return jsonError(error);
  }
}
