import { NextResponse, type NextRequest } from 'next/server';

import { recordCompletion, verifyCompletion, getAssignmentCompletions } from '@/src/server/pilot/progression';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete']);

    const assignmentId = request.nextUrl.searchParams.get('assignment_id');

    if (!assignmentId) {
      throw new Error('Missing assignment_id');
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

    // Record the completion
    const completion = await recordCompletion({
      organizationId: principal.organizationId,
      assignmentId: body.assignment_id,
      athleteId: body.athlete_id,
      repsCompleted: body.reps_completed,
      notes: body.notes,
    });

    // If verification requested (coach only)
    if (body.verify && (principal.role === 'coach' || principal.role === 'admin' || principal.role === 'organization_admin')) {
      await verifyCompletion(completion.completion_id, principal.accountId, body.verified || false);
    }

    return NextResponse.json(completion, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
