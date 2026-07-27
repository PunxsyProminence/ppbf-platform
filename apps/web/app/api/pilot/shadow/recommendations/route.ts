import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  createProvisionalRecommendation,
  listRecommendations,
  MedicalStatusBlockedError,
  type ShadowRecommendationStatus,
} from '@/src/server/pilot/shadowRecommendations';

export const runtime = 'nodejs';

const DECISION_LOOP_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const RECOMMENDATION_STATUSES = new Set<string>(['provisional', 'accepted', 'rejected', 'expired', 'superseded']);
const REQUIRED_TABLES = ['shadow_recommendations', 'shadow_audit_entries'];

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athleteId');
    const statusParam = request.nextUrl.searchParams.get('status');
    if (!boundedString(athleteId, 300)) {
      return NextResponse.json({ ok: false, error: 'athleteId is required.' }, { status: 400 });
    }
    if (statusParam !== null && !RECOMMENDATION_STATUSES.has(statusParam)) {
      return NextResponse.json({ ok: false, error: 'Invalid status filter.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const recommendations = await listRecommendations({
      organizationId: principal.organizationId,
      athleteId,
      status: (statusParam as ShadowRecommendationStatus | null) ?? undefined,
    });

    return NextResponse.json({ ok: true, recommendations });
  } catch (error) {
    return jsonError(error);
  }
}

interface RecommendationRequestBody {
  athleteId?: unknown;
  sourceFormulaResultId?: unknown;
  recommendationText?: unknown;
  expectedOutcome?: unknown;
  expiresInHours?: unknown;
  isMedicallySensitive?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as RecommendationRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.recommendationText, 4000)
      || !boundedString(body.expectedOutcome, 2000)
      || (body.sourceFormulaResultId !== undefined && body.sourceFormulaResultId !== null && !boundedString(body.sourceFormulaResultId, 300))
      || (body.expiresInHours !== undefined && (typeof body.expiresInHours !== 'number' || !Number.isFinite(body.expiresInHours) || body.expiresInHours <= 0))
      || (body.isMedicallySensitive !== undefined && typeof body.isMedicallySensitive !== 'boolean')
    ) {
      return NextResponse.json({ ok: false, error: 'Recommendation payload is invalid.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const recommendation = await createProvisionalRecommendation({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      sourceFormulaResultId: body.sourceFormulaResultId as string | null | undefined,
      recommendationText: body.recommendationText,
      expectedOutcome: body.expectedOutcome,
      createdByAccountId: principal.accountId,
      createdByRole: principal.role,
      expiresInHours: body.expiresInHours as number | undefined,
      isMedicallySensitive: body.isMedicallySensitive as boolean | undefined,
    });

    return NextResponse.json({ ok: true, recommendation });
  } catch (error) {
    if (error instanceof MedicalStatusBlockedError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return jsonError(error);
  }
}
