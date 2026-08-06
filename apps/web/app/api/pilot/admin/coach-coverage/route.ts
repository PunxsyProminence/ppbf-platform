import { NextResponse, type NextRequest } from 'next/server';

import { grantCoachCoverage, isOrganizationAdminRole } from '@/src/server/pilot/access';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);

    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const body = (await request.json()) as {
      athlete_id?: string;
      covering_coach_id?: string;
      ttl_hours?: number;
    };

    const athleteId = body.athlete_id?.trim() || '';
    const coveringCoachId = body.covering_coach_id?.trim() || '';

    if (!athleteId || !coveringCoachId) {
      throw new Error('Missing athlete_id or covering_coach_id');
    }

    const result = await grantCoachCoverage({
      organizationId: principal.organizationId,
      athleteId,
      coveringCoachId,
      grantedByAccountId: principal.accountId,
      ttlHours: body.ttl_hours,
    });

    return NextResponse.json({
      ok: true,
      coverage_id: result.coverageId,
      organization_id: principal.organizationId,
      athlete_id: athleteId,
      covering_coach_id: coveringCoachId,
      expires_at: result.expiresAt,
    });
  } catch (error) {
    return jsonError(error);
  }
}
