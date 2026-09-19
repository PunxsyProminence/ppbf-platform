import { NextResponse, type NextRequest } from 'next/server';

// The aliasing requireRole, on its own line: coachingContentAccess.test.ts
// holds every route under the reader policy to exactly this import.
import { requireRole } from '@/src/server/pilot/access';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import { resolveAssignmentDrillInstruction } from '@/src/server/pilot/assignmentDrillInstruction';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getDrillAssignmentById } from '@/src/server/pilot/progression';

export const runtime = 'nodejs';

// GET ?assignment_id= -- the drill instruction a piece of assigned work links
// to (OD-2026-09-19-001, W-D4B). GET only: opening a drill from an assignment
// is reading, and this route has no other verb.
//
// TWO GATES, BOTH REQUIRED.
//   The content gate -- COACHING_CONTENT_READER_ROLES, the one policy for
//   reading drill content (coachingContentAccess.ts). This route serves that
//   content class, so it joins that policy rather than keeping a list of its
//   own.
//   The record gate -- the assignment belongs to one athlete, and the actor
//   must be able to see that athlete: the athlete themself, their coach of
//   record or covering coach, an administrator of the gym, or a linked
//   guardian. Every other reader role (platform owner, volunteer, staff) is
//   refused here.
//
// "No such assignment" and "not yours" answer identically, as the completions
// read does, so an assignment id cannot be probed for existence.
//
// THE SHAPE FOLLOWS THE SESSION, NEVER THE REQUEST. Coaches and gym
// administrators get the full reference detail. Everyone else who passes both
// gates -- the athlete, and a guardian reading their athlete's work -- gets the
// athlete-safe projection: the Learn (promoted-and-live) read, except that open
// work reads the OD-2026-09-19-002 open-work read. A retracted reference is
// withheld either way. There is no parameter that asks for the other shape.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);

    const assignmentId = request.nextUrl.searchParams.get('assignment_id');
    if (!assignmentId) {
      throw new Error('Missing assignment_id');
    }

    const assignment = await getDrillAssignmentById(principal.organizationId, assignmentId);
    if (!assignment) {
      return hiddenNotFound();
    }
    try {
      await assertActorCanAccessAthlete(principal, assignment.athlete_id);
    } catch (error) {
      // Only a refusal is folded into the hidden 404. Every refusal the access
      // check makes is a 'Forbidden: ...' error; anything else -- a database
      // that did not answer -- is a server fault, and reporting it as "not
      // found" would hide an outage from the people who run the gym's server.
      if (error instanceof Error && error.message.startsWith('Forbidden')) {
        return hiddenNotFound();
      }
      throw error;
    }

    // The staff shape is named, and everything else gets the athlete-safe one.
    // Today only coaches and administrators reach this line as staff, but if
    // the record gate is ever widened to another role, that role gets the
    // projection, not the provenance.
    const isStaff = principal.role === 'coach' || principal.role === 'admin' || principal.role === 'organization_admin';
    const audience = isStaff ? 'coach' : 'athlete';
    const [instruction, assignedBy] = await Promise.all([
      resolveAssignmentDrillInstruction(principal.organizationId, assignment, audience),
      // A name, never the account id: the same derived signature the athlete
      // already reads on recognitions and development blocks.
      getCoachDisplayName(principal.organizationId, assignment.assigned_by_account_id),
    ]);

    return NextResponse.json({
      assignment_id: assignment.assignment_id,
      assigned_by: assignedBy,
      ...instruction,
    });
  } catch (error) {
    return jsonError(error);
  }
}
