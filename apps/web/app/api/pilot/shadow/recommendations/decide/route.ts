import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { decideOnRecommendation } from '@/src/server/pilot/shadowRecommendations';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

interface DecideRequestBody {
  athleteId?: unknown;
  recommendationId?: unknown;
  decision?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as DecideRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.recommendationId, 300)
      || (body.decision !== 'accepted' && body.decision !== 'rejected')
    ) {
      return NextResponse.json({ ok: false, error: 'Decide payload is invalid.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_recommendations', 'shadow_audit_entries'] });

    const recommendation = await decideOnRecommendation({
      organizationId: principal.organizationId,
      recommendationId: body.recommendationId,
      decision: body.decision,
      decidedByAccountId: principal.accountId,
      decidedByRole: principal.role,
    });

    if (!recommendation) {
      return hiddenNotFound();
    }

    return NextResponse.json({ ok: true, recommendation });
  } catch (error) {
    return jsonError(error);
  }
}
