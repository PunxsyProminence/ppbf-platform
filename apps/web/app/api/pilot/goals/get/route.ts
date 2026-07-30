import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getGoalById } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const body = (await request.json()) as { goal_id?: string };
    const goalId = body.goal_id?.trim() || '';
    if (!goalId) {
      throw new Error('Missing goal_id');
    }

    const goal = await getGoalById(principal.organizationId, goalId);
    if (!goal) {
      return NextResponse.json({ found: false });
    }

    await assertActorCanAccessAthlete(principal, goal.athlete_id);
    return NextResponse.json({ found: true, goal });
  } catch (error) {
    return jsonError(error);
  }
}
