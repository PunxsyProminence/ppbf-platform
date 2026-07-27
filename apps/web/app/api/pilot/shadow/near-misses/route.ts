import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { flagNearMiss, listNearMisses, type ShadowNearMissSeverity } from '@/src/server/pilot/shadowNearMisses';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

const SEVERITIES = new Set<string>(['low', 'moderate', 'high', 'critical']);
const REQUIRED_TABLES = ['shadow_near_misses', 'shadow_audit_entries'];

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

    const nearMisses = await listNearMisses(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, nearMisses });
  } catch (error) {
    return jsonError(error);
  }
}

interface NearMissRequestBody {
  athleteId?: unknown;
  decisionId?: unknown;
  description?: unknown;
  severity?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as NearMissRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.description, 4000)
      || typeof body.severity !== 'string'
      || !SEVERITIES.has(body.severity)
      || (body.decisionId !== undefined && body.decisionId !== null && !boundedString(body.decisionId, 300))
    ) {
      return NextResponse.json({ ok: false, error: 'Near-miss payload is invalid.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    const nearMiss = await flagNearMiss({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      decisionId: body.decisionId as string | null | undefined,
      description: body.description,
      severity: body.severity as ShadowNearMissSeverity,
      detectedByAccountId: principal.accountId,
      detectedByRole: principal.role,
    });

    return NextResponse.json({ ok: true, nearMiss });
  } catch (error) {
    return jsonError(error);
  }
}
