import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  InvalidAchievementInput,
  awardMilestone,
  countCompletedSessions,
  getAthleteProgram,
  listMilestoneAwards,
  setAthleteProgram,
} from '@/src/server/pilot/achievements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * NON-FIGHT MILESTONES — conditioning, craft, community, consistency.
 *
 * The catalogue is apps/web/src/shared/achievementPaths.ts; this route stores
 * and reads the awards, plus the program an athlete came for, which is what
 * decides WHICH tracks they see. Both are returned together because a client
 * cannot draw a path without both, and two round trips to draw one panel is two
 * chances for it to render half-built.
 *
 * SELF-MARKING IS DELIBERATE. An athlete may mark their own mile, plank or rope
 * work. A fitness-only member's whole progression would otherwise depend on
 * whether a coach happened to be watching, which is exactly the "the real
 * system is for the boxers" signal this work exists to remove. A coach mark and
 * a self mark are stored distinguishably and neither outranks the other.
 *
 * NOTHING HERE EXPIRES OR DECAYS. There is no DELETE and no re-qualification.
 * An award is a thing that happened, and a thing that happened is not undone by
 * three months away.
 */

const MILESTONE_READER_ROLES = ['coach', 'organization_admin', 'admin', 'athlete', 'parent'] as const;
const MILESTONE_WRITER_ROLES = ['coach', 'organization_admin', 'admin', 'athlete'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MILESTONE_READER_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    /* The completed-session COUNT travels with the awards because the
       consistency track is computed from it and a client cannot draw the path
       without it. A count and not the session list: a guardian is not admitted
       to /api/pilot/sessions/list, which carries every date, RPE and note, and
       a progression needs the number rather than the log. */
    const [items, program, completedSessions] = await Promise.all([
      listMilestoneAwards(principal.organizationId, athleteId),
      getAthleteProgram(principal.organizationId, athleteId),
      countCompletedSessions(principal.organizationId, athleteId),
    ]);

    return NextResponse.json({
      ok: true,
      program,
      completed_sessions: completedSessions,
      items,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MILESTONE_WRITER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    // The role is derived from who is signed in, never taken from the body: an
    // athlete cannot claim a coach witnessed something.
    const awardedByRole = principal.role === 'athlete' ? 'self' : 'coach';

    const award = await awardMilestone({
      organizationId: principal.organizationId,
      athleteId,
      milestoneKey: typeof body.milestone_key === 'string' ? body.milestone_key : '',
      awardedByRole,
      awardedByAccountId: principal.accountId,
      note: typeof body.note === 'string' ? body.note : '',
    });

    if (!award) {
      throw new Error('Milestone was not written');
    }

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete_milestone',
      entity_id: `${athleteId}:${award.milestone_key}`,
      details: { athlete_id: athleteId, milestone_key: award.milestone_key },
    });

    return NextResponse.json({ ok: true, award }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidAchievementInput) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return jsonError(error);
  }
}

/**
 * Sets which program an athlete is here for.
 *
 * An athlete may set their own: this is the answer to "what did you come for",
 * and it is not a rank, a level, or a clearance. Nothing about it gates access
 * to anything — it only decides which tracks their path shows.
 */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MILESTONE_WRITER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const program = await setAthleteProgram({
      organizationId: principal.organizationId,
      athleteId,
      program: typeof body.program === 'string' ? body.program : '',
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete_program',
      entity_id: athleteId,
      details: { athlete_id: athleteId, program },
    });

    return NextResponse.json({ ok: true, program });
  } catch (error) {
    if (error instanceof InvalidAchievementInput) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return jsonError(error);
  }
}
