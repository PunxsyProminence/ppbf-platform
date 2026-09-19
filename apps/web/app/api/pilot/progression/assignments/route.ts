import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { DRILL_DIFFICULTIES, getDrill, isDrillDifficulty } from '@/src/server/pilot/drills';
import { ValidationError } from '@/src/server/pilot/errors';
import {
  assignDrill,
  getAthleteAssignments,
  getProgressionGapById,
  requireAssignableDrillId,
} from '@/src/server/pilot/progression';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * True when a legacy identity field actually says something. Absent, null and
 * empty-or-whitespace strings are silence and pass; anything else -- including
 * a non-string -- is an attempt to supply drill wording and is refused.
 */
function carriesText(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

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
      drill_id?: unknown;
      drill_name?: unknown;
      drill_description?: unknown;
      drill_difficulty?: string;
      rep_count?: number;
      duration_minutes?: number;
      frequency_per_week?: number;
      due_date?: string;
    };

    if (!body.gap_id || !body.athlete_id) {
      throw new Error('Missing required fields');
    }

    // W-D3, OD-2026-09-18-001. Every new assignment is anchored to an active
    // operational drill in this gym. There is no longer a typed-out
    // assignment: the drill IS the identity, and its wording is snapshotted
    // from pilot.drills by assignDrill. Checked as a real string rather than
    // with `?.trim()`, which threw a TypeError -- and so a 500 -- on a numeric
    // drill_id.
    const drillId = requireAssignableDrillId(body.drill_id);

    // THE STALE-CLIENT RULE. A request still carrying typed drill wording was
    // built for the old contract, where that text would have been stored. It
    // is refused rather than silently discarded: discarding it would report
    // success while throwing away exactly what the coach wrote, and a coach
    // cannot learn that their words went nowhere from a 201. An absent or empty
    // field says nothing and is tolerated.
    if (carriesText(body.drill_name) || carriesText(body.drill_description)) {
      throw new ValidationError(
        'drill_name and drill_description are no longer accepted: a new assignment takes its wording from the drill.',
        'DRILL_TEXT_NOT_ACCEPTED',
      );
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
    // rather than as a drill the caller may not touch. getDrill reads
    // pilot.drills only, so a reference-library id is absent here too -- it is
    // not assignable, and it reads exactly like an id that does not exist.
    // assignDrill re-checks all of this inside its own write; this pre-check
    // exists to make the refusal legible, not to make the write safe.
    const drill = await getDrill(principal.organizationId, drillId);
    if (!drill) {
      return hiddenNotFound();
    }

    // A retired drill is one the gym has stopped teaching. Assignments that
    // already reference it keep it; a new one does not get to revive it
    // silently, and restoring the drill is the way to assign it again.
    if (!drill.active) {
      throw new Error('Unsupported drill_id: that drill is retired');
    }

    const assignment = await assignDrill({
      organizationId: principal.organizationId,
      gapId: body.gap_id,
      athleteId: body.athlete_id,
      assignedByAccountId: principal.accountId,
      drillId,
      // The one piece of drill wording a coach may still set: an explicit
      // difficulty overrides the drill's own, exactly as before. Name and
      // description come from the drill, in the writer.
      drillDifficulty: body.drill_difficulty,
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
