import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  InvalidAchievementInput,
  createPersonalGoal,
  listPersonalGoals,
  markPersonalGoalReached,
} from '@/src/server/pilot/achievements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * PERSONAL GOALS — what the athlete said mattered, in their own words.
 *
 * Distinct from POST /api/pilot/goals, which writes a SMART goal with a
 * required date and a required success metric. Both write pilot.goals; this one
 * asks for a sentence and nothing else.
 *
 * WHY IT IS NOT A PICKLIST. "Run a mile without stopping", "show up on the days
 * I don't want to", "be a better training partner" — none of those is a boxing
 * metric, and every one of them is the actual reason somebody is in the
 * building. A picklist of gym KPIs would have quietly told them their reason
 * was not one of the options.
 *
 * NOTHING FAILS HERE. There is no missed state, no overdue flag and no route
 * that could set one. A goal is either reached or still being worked on, and
 * the second of those is not a lesser state — it is the ordinary one.
 */

const GOAL_ROLES = ['athlete', 'coach', 'organization_admin', 'admin', 'parent'] as const;
const GOAL_WRITER_ROLES = ['athlete', 'coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GOAL_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listPersonalGoals(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GOAL_WRITER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const goal = await createPersonalGoal({
      organizationId: principal.organizationId,
      athleteId,
      ownWords: typeof body.own_words === 'string' ? body.own_words : '',
      whyItMatters: typeof body.why_it_matters === 'string' ? body.why_it_matters : '',
      // Empty string means "no date", which is a real answer here.
      targetDate: typeof body.target_date === 'string' && body.target_date.trim()
        ? body.target_date.trim()
        : null,
      setByRole: principal.role,
    });

    /* The audit row records that a goal was set and by whom. It does NOT copy
       the words: a goal written in somebody's own language, often about
       something they are struggling with, does not belong in an operational log
       that the person who wrote it never reads. */
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'goal',
      entity_id: goal.goal_id,
      details: { athlete_id: athleteId, goal_kind: 'own_words' },
    });

    return NextResponse.json({ ok: true, goal }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidAchievementInput) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return jsonError(error);
  }
}

/**
 * Reached it.
 *
 * Idempotent in the data layer, so a second tap returns the same row with the
 * same date rather than moving the day it happened.
 */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GOAL_WRITER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    const goalId = typeof body.goal_id === 'string' ? body.goal_id.trim() : '';
    if (!athleteId || !goalId) {
      throw new Error('Missing athlete_id or goal_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    // The authorized athlete travels INTO the write, so the statement can only
    // reach a goal this actor was cleared for. Previously the mark was keyed on
    // goal_id alone and the owner was compared to `athleteId` afterwards -- by
    // which point another athlete's goal had already been stamped reached, and
    // the 404 below described a mutation that had happened rather than one that
    // was refused. `athleteId` is the only athlete assertActorCanAccessAthlete
    // has cleared above, which is exactly why it is what the write is keyed on.
    const goal = await markPersonalGoalReached(principal.organizationId, goalId, athleteId);
    if (!goal) {
      // Same response for "no such goal" and "somebody else's goal", so the
      // identifier cannot be probed.
      throw new Error('Not found');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'goal',
      entity_id: goal.goal_id,
      details: { athlete_id: athleteId, reached: true },
    });

    return NextResponse.json({ ok: true, goal });
  } catch (error) {
    return jsonError(error);
  }
}
