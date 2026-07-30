import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { listDecisions, recordDecision, RecommendationNotActionableError } from '@/src/server/pilot/shadowDecisions';
import { MedicalStatusBlockedError } from '@/src/server/pilot/shadowRecommendations';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

const REQUIRED_TABLES = ['shadow_decisions', 'shadow_audit_entries'];

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athleteId');
    if (!boundedString(athleteId, 300)) {
      return NextResponse.json({ ok: false, error: 'athleteId is required.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const decisions = await listDecisions(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, decisions });
  } catch (error) {
    return jsonError(error);
  }
}

interface DecisionRequestBody {
  athleteId?: unknown;
  recommendationId?: unknown;
  decisionText?: unknown;
  expectedOutcome?: unknown;
  isMedicallySensitive?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as DecisionRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.decisionText, 4000)
      || !boundedString(body.expectedOutcome, 2000)
      || (body.recommendationId !== undefined && body.recommendationId !== null && !boundedString(body.recommendationId, 300))
      || (body.isMedicallySensitive !== undefined && typeof body.isMedicallySensitive !== 'boolean')
    ) {
      return NextResponse.json({ ok: false, error: 'Decision payload is invalid.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const decision = await recordDecision({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      recommendationId: body.recommendationId as string | null | undefined,
      decisionText: body.decisionText,
      expectedOutcome: body.expectedOutcome,
      decidedByAccountId: principal.accountId,
      decidedByRole: principal.role,
      isMedicallySensitive: body.isMedicallySensitive as boolean | undefined,
    });

    return NextResponse.json({ ok: true, decision });
  } catch (error) {
    if (error instanceof MedicalStatusBlockedError || error instanceof RecommendationNotActionableError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return jsonError(error);
  }
}
