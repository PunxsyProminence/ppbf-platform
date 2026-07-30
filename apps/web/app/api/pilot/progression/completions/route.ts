import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  recordCompletion,
  verifyCompletion,
  getAssignmentCompletions,
  getDrillAssignmentById,
} from '@/src/server/pilot/progression';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete', 'parent']);

    const assignmentId = request.nextUrl.searchParams.get('assignment_id');

    if (!assignmentId) {
      throw new Error('Missing assignment_id');
    }

    const assignment = await getDrillAssignmentById(principal.organizationId, assignmentId);

    // "Doesn't exist" and "exists but forbidden" collapse to the same
    // response so a caller can't use this endpoint to enumerate assignment
    // IDs belonging to athletes they can't access.
    if (!assignment) {
      return hiddenNotFound();
    }

    try {
      await assertActorCanAccessAthlete(principal, assignment.athlete_id);
    } catch {
      return hiddenNotFound();
    }

    const completions = await getAssignmentCompletions(principal.organizationId, assignmentId);

    return NextResponse.json({ items: completions });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete', 'coach', 'admin', 'organization_admin']);

    const body = (await request.json()) as {
      assignment_id?: string;
      athlete_id?: string;
      reps_completed?: number;
      notes?: string;
      verify?: boolean;
      verified?: boolean;
    };

    if (!body.assignment_id || !body.athlete_id) {
      throw new Error('Missing assignment_id or athlete_id');
    }

    await assertActorCanAccessAthlete(principal, body.athlete_id);

    const assignment = await getDrillAssignmentById(principal.organizationId, body.assignment_id);
    if (!assignment || assignment.athlete_id !== body.athlete_id) {
      return NextResponse.json({ error: 'Assignment does not belong to the specified athlete' }, { status: 400 });
    }

    // Record the completion
    const completion = await recordCompletion({
      organizationId: principal.organizationId,
      assignmentId: body.assignment_id,
      athleteId: body.athlete_id,
      repsCompleted: body.reps_completed,
      notes: body.notes,
    });

    // If verification requested (coach only). assertActorCanAccessAthlete
    // above already confirmed this coach is assigned to body.athlete_id.
    if (body.verify && (principal.role === 'coach' || principal.role === 'admin' || principal.role === 'organization_admin')) {
      await verifyCompletion(completion.completion_id, principal.accountId, body.verified || false);
    }

    return NextResponse.json(completion, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
