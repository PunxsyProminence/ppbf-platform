import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  getLatestMedicalAdministrativeStatus,
  setMedicalAdministrativeStatus,
  type MedicalAdministrativeStatusValue,
} from '@/src/server/pilot/shadowMedicalStatus';

export const runtime = 'nodejs';

const DECISION_LOOP_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const STATUS_VALUES = new Set<string>(['cleared', 'restricted', 'not_cleared', 'pending']);

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
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_medical_administrative_status'] });

    const status = await getLatestMedicalAdministrativeStatus(principal.organizationId, athleteId);
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return jsonError(error);
  }
}

interface MedicalStatusRequestBody {
  athleteId?: unknown;
  status?: unknown;
  restrictionFlags?: unknown;
  sourceReference?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as MedicalStatusRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || typeof body.status !== 'string'
      || !STATUS_VALUES.has(body.status)
      || (body.sourceReference !== undefined && !boundedString(body.sourceReference, 500))
      || (
        body.restrictionFlags !== undefined
        && (typeof body.restrictionFlags !== 'object' || body.restrictionFlags === null || Array.isArray(body.restrictionFlags))
      )
    ) {
      return NextResponse.json({ ok: false, error: 'Medical status payload is invalid.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_medical_administrative_status'] });

    const status = await setMedicalAdministrativeStatus({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      status: body.status as MedicalAdministrativeStatusValue,
      restrictionFlags: body.restrictionFlags as Record<string, unknown> | undefined,
      sourceReference: body.sourceReference as string | undefined,
      setByAccountId: principal.accountId,
      setByRole: principal.role,
    });

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return jsonError(error);
  }
}
