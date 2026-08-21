import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query, queryOne } from '@/src/server/pilot/db';
import { ForbiddenError, NotFoundError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The plan is stored whole as jsonb, so the row size is whatever the client
// sends. Matches the SHADOW job payload ceiling.
const MAX_PLAN_BYTES = 100_000;

type FloorPlanPayload = {
  athleteName: string;
  readiness: string;
  generatedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    description: string;
    dueDate: string;
    priority: 'High' | 'Normal';
    linkedGoalId?: string;
    // Absent on a plan the moment it is generated -- nothing has been done
    // yet -- and written by PATCH below when the athlete ticks the task off.
    // Optional rather than defaulted, because "not recorded" and "recorded as
    // not done" read the same on the floor and only one of them is a claim
    // about the athlete.
    completed?: boolean;
  }>;
};

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete']);

    const limitRaw = request.nextUrl.searchParams.get('limit');
    const limit = Math.min(Math.max(Number.parseInt(limitRaw || '30', 10) || 30, 1), 100);

    if (principal.role === 'athlete') {
      if (!principal.athleteId) {
        return NextResponse.json({ items: [] });
      }

      const items = await query<{
        athlete_id: string;
        payload: FloorPlanPayload;
      }>(
        `select athlete_id, payload
         from pilot.athlete_floor_plans
         where organization_id = $1 and athlete_id = $2
         order by generated_at desc
         limit $3`,
        [principal.organizationId, principal.athleteId, limit],
      );

      return NextResponse.json({ items: items.map((row) => row.payload) });
    }

    if (principal.role === 'coach') {
      const items = await query<{ athlete_id: string; payload: FloorPlanPayload }>(
        `select fp.athlete_id, fp.payload
         from pilot.athlete_floor_plans fp
         join pilot.athletes a on a.organization_id = fp.organization_id and a.athlete_id = fp.athlete_id
         where fp.organization_id = $1 and a.coach_id = $2
         order by fp.generated_at desc
         limit $3`,
        [principal.organizationId, principal.accountId, limit],
      );

      return NextResponse.json({ items: items.map((row) => row.payload) });
    }

    if (!isOrganizationAdminRole(principal.role)) {
      return NextResponse.json({ items: [] });
    }

    const items = await query<{ athlete_id: string; payload: FloorPlanPayload }>(
      `select athlete_id, payload
       from pilot.athlete_floor_plans
       where organization_id = $1
       order by generated_at desc
       limit $2`,
      [principal.organizationId, limit],
    );

    return NextResponse.json({ items: items.map((row) => row.payload) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete']);

    const body = (await request.json()) as {
      athlete_id?: string;
      plan?: FloorPlanPayload;
    };

    let athleteId = body.athlete_id?.trim() || '';
    if (principal.role === 'athlete') {
      athleteId = principal.athleteId || '';
    }

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    if (!body.plan || typeof body.plan !== 'object') {
      throw new Error('Missing plan');
    }

    const plan = body.plan;
    const serializedPlan = JSON.stringify(plan);
    if (Buffer.byteLength(serializedPlan, 'utf8') > MAX_PLAN_BYTES) {
      throw new Error('Request body plan exceeds the allowed size');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    // generated_at is timestamptz, and the raw client string reached it
    // unchecked -- anything Postgres could not parse failed the insert and
    // surfaced as a masked 500 instead of storing the plan.
    const claimedGeneratedAt = typeof plan.generatedAt === 'string' ? new Date(plan.generatedAt) : null;
    const generatedAt = claimedGeneratedAt && !Number.isNaN(claimedGeneratedAt.getTime())
      ? claimedGeneratedAt.toISOString()
      : new Date().toISOString();

    await query(
      `insert into pilot.athlete_floor_plans (
         organization_id,
         plan_id,
         athlete_id,
         generated_at,
         readiness,
         athlete_name,
         payload,
         created_by_account_id,
         created_by_role,
         created_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,now()
       )`,
      [
        principal.organizationId,
        randomUUID(),
        athleteId,
        generatedAt,
        plan.readiness || 'UNKNOWN',
        plan.athleteName || 'Unknown Athlete',
        serializedPlan,
        principal.accountId,
        principal.role,
      ],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Record that one task on the athlete's current floor plan is done, or undo it.
 *
 * Until this existed the table was insert-only and the checkbox on the floor
 * moved React state alone: an athlete ticked their work off, reloaded, and the
 * floor came back untouched. The plan is stored whole as jsonb, so the task
 * list inside `payload` is already the place a completion belongs -- this
 * writes the flag there rather than adding a table or a column for it.
 *
 * WHICH PLAN. The athlete's newest one, which is exactly the plan the floor is
 * showing: GET orders by generated_at desc and the workspace reads limit=1.
 * There is no plan_id in the request because the client is never given one.
 *
 * WHOSE PLAN. The principal's. This route reads no athlete_id from the body or
 * the query string at all, so there is nothing here to forge -- an athlete
 * cannot address another athlete's plan even by naming it. Athlete-only by
 * role, because this is the athlete's own record of what they did and no other
 * role has a surface for it.
 *
 * Read-modify-write rather than a jsonb_set expression: the whole payload is
 * rewritten, so two writes racing on the same plan would lose one. The
 * workspace sends one at a time and holds the boxes while it does. Two tabs on
 * the same plan could still race; the losing tick is recoverable by ticking it
 * again, which is why this is stated rather than defended against.
 */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete']);

    const athleteId = principal.athleteId;
    if (!athleteId) {
      throw new ForbiddenError('Forbidden: this account is not linked to an athlete record');
    }

    const body = (await request.json()) as { task_id?: string; completed?: boolean };
    const taskId = body.task_id?.trim() || '';
    const completed = body.completed;

    if (!taskId) {
      throw new ValidationError('Missing task_id');
    }
    if (typeof completed !== 'boolean') {
      throw new ValidationError('Missing completed');
    }

    const current = await queryOne<{ plan_id: string; payload: FloorPlanPayload }>(
      `select plan_id, payload
         from pilot.athlete_floor_plans
        where organization_id = $1 and athlete_id = $2
        order by generated_at desc
        limit 1`,
      [principal.organizationId, athleteId],
    );

    if (!current) {
      throw new NotFoundError('Not found: there is no floor plan to write this on');
    }

    const tasks = Array.isArray(current.payload?.tasks) ? current.payload.tasks : [];
    if (!tasks.some((task) => task.id === taskId)) {
      throw new NotFoundError('Not found: that task is not on your current floor plan');
    }

    const payload: FloorPlanPayload = {
      ...current.payload,
      tasks: tasks.map((task) => (task.id === taskId ? { ...task, completed } : task)),
    };

    await query(
      `update pilot.athlete_floor_plans
          set payload = $1
        where organization_id = $2 and plan_id = $3 and athlete_id = $4`,
      [JSON.stringify(payload), principal.organizationId, current.plan_id, athleteId],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
