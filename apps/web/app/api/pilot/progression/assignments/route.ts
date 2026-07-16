import { NextResponse, type NextRequest } from 'next/server';

import { assignDrill, getAthleteAssignments } from '@/src/server/pilot/progression';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    const assignments = await getAthleteAssignments(principal.organizationId, athleteId, status || undefined);

    return NextResponse.json({ items: assignments });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const body = (await request.json()) as {
      gap_id?: string;
      athlete_id?: string;
      drill_name?: string;
      drill_description?: string;
      drill_difficulty?: string;
      rep_count?: number;
      duration_minutes?: number;
      frequency_per_week?: number;
      due_date?: string;
    };

    if (!body.gap_id || !body.athlete_id || !body.drill_name || !body.drill_description) {
      throw new Error('Missing required fields');
    }

    const assignment = await assignDrill({
      organizationId: principal.organizationId,
      gapId: body.gap_id,
      athleteId: body.athlete_id,
      assignedByAccountId: principal.accountId,
      drillName: body.drill_name,
      drillDescription: body.drill_description,
      drillDifficulty: body.drill_difficulty || 'intermediate',
      repCount: body.rep_count,
      durationMinutes: body.duration_minutes,
      frequencyPerWeek: body.frequency_per_week,
      dueDate: body.due_date,
    });

    return NextResponse.json(assignment, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
