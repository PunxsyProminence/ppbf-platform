import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { getShadowEventTimeline, listShadowEvents } from '@/src/server/pilot/shadowReadModels';
import { SHADOW_PROJECTION_READ_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_events'] });

    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
      entity_type?: string;
      entity_id?: string;
      event_name?: string;
      correlation_id?: string;
      created_after?: string;
      timeline?: boolean;
    };

    const context = {
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      athleteId: principal.athleteId,
    };

    const filters = {
      limit: body.limit,
      offset: body.offset,
      entityType: body.entity_type,
      entityId: body.entity_id,
      eventName: body.event_name,
      correlationId: body.correlation_id,
      createdAfter: body.created_after,
    };

    const events = body.timeline
      ? await getShadowEventTimeline(context, {
          entityType: body.entity_type,
          entityId: body.entity_id,
          correlationId: body.correlation_id,
          limit: body.limit,
        })
      : await listShadowEvents(context, filters);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      events,
    });
  } catch (error) {
    return jsonError(error);
  }
}
