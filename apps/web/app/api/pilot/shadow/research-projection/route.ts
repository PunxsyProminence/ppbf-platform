import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { getShadowResearchProjection } from '@/src/server/pilot/shadowReadModels';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff']);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_events'] });

    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
      created_after?: string;
    };

    const items = await getShadowResearchProjection(
      {
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        athleteId: principal.athleteId,
      },
      {
        limit: body.limit,
        offset: body.offset,
        createdAfter: body.created_after,
      },
    );

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      items,
    });
  } catch (error) {
    return jsonError(error);
  }
}
