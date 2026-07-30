import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { listShadowTelemetry } from '@/src/server/pilot/shadowReadModels';
import { SHADOW_PROJECTION_READ_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_telemetry_events'] });

    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
      metric_name?: string;
      correlation_id?: string;
      created_after?: string;
    };

    const telemetry = await listShadowTelemetry(
      {
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        athleteId: principal.athleteId,
      },
      {
        limit: body.limit,
        offset: body.offset,
        metricName: body.metric_name,
        correlationId: body.correlation_id,
        createdAfter: body.created_after,
      },
    );

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      telemetry,
    });
  } catch (error) {
    return jsonError(error);
  }
}
