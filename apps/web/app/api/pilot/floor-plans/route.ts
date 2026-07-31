import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
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
