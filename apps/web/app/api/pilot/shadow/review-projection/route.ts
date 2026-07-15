import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { getShadowReviewProjection } from '@/src/server/pilot/shadowReadModels';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'parent']);
    await assertShadowRuntimeReadiness({ requiredTables: ['intake_cases', 'intake_documents', 'shadow_events'] });

    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
      intake_case_id?: string;
      status?: 'pending_review' | 'approved' | 'rejected' | 'promoted';
    };

    const projection = await getShadowReviewProjection(
      {
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        athleteId: principal.athleteId,
      },
      {
        limit: body.limit,
        offset: body.offset,
        entityId: body.intake_case_id,
        eventName: body.status,
      },
    );

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      queue: projection.items,
      total: projection.total,
    });
  } catch (error) {
    return jsonError(error);
  }
}
