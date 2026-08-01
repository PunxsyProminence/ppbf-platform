import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { DRILL_DIFFICULTIES, getDrill, isDrillDifficulty } from '@/src/server/pilot/drills';
import { assignDrill, getAthleteAssignments, getProgressionGapById } from '@/src/server/pilot/progression';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete', 'parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

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
      drill_id?: string;
      drill_name?: string;
      drill_description?: string;
      drill_difficulty?: string;
      rep_count?: number;
      duration_minutes?: number;
      frequency_per_week?: number;
      due_date?: string;
    };

    // A coach either picks a drill from the gym's library or types one out.
    // Both are complete assignments: drill_id is the anchor, the typed text is
    // the record, and an assignment may carry either or both.
    const drillId = body.drill_id?.trim() || null;
    const typedName = body.drill_name?.trim() || '';
    const typedDescription = body.drill_description?.trim() || '';

    if (!body.gap_id || !body.athlete_id) {
      throw new Error('Missing required fields');
    }

    if (!drillId && (!typedName || !typedDescription)) {
      throw new Error('Missing required fields: drill_id, or drill_name and drill_description');
    }

    // Checked here rather than left to the CHECK constraint, so an unknown
    // level is a 400 naming the vocabulary instead of a 500 from SQLSTATE 23514.
    if (body.drill_difficulty !== undefined && !isDrillDifficulty(body.drill_difficulty)) {
      throw new Error(`Unsupported drill_difficulty: one of ${DRILL_DIFFICULTIES.join(', ')}`);
    }

    await assertActorCanAccessAthlete(principal, body.athlete_id);

    // Reject a gap_id that belongs to another organization or to a
    // different athlete without revealing whether it exists at all.
    const gap = await getProgressionGapById(principal.organizationId, body.gap_id);
    if (!gap || gap.athlete_id !== body.athlete_id) {
      return hiddenNotFound();
    }

    // Same treatment for the drill: another gym's drill_id must read as absent
    // rather than as a drill the caller may not touch. The composite foreign
    // key would refuse the write anyway; this makes the refusal legible.
    const drill = drillId ? await getDrill(principal.organizationId, drillId) : null;
    if (drillId && !drill) {
      return hiddenNotFound();
    }

    // A retired drill is one the gym has stopped teaching. Assignments that
    // already reference it keep it; a new one does not get to revive it
    // silently, and restoring the drill is the way to assign it again.
    if (drill && !drill.active) {
      throw new Error('Unsupported drill_id: that drill is retired');
    }

    const assignment = await assignDrill({
      organizationId: principal.organizationId,
      gapId: body.gap_id,
      athleteId: body.athlete_id,
      assignedByAccountId: principal.accountId,
      drillId,
      // What the coach typed wins over the drill's own wording: it is the
      // record of what was assigned that day, and nothing later rewrites it.
      drillName: typedName || (drill ? drill.name : ''),
      drillDescription: typedDescription || (drill ? drill.focus : ''),
      drillDifficulty: body.drill_difficulty || (drill ? drill.difficulty : 'intermediate'),
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
