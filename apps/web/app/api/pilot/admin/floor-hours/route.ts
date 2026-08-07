import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getFloorHoursAdmin, recordActivityAdjustment } from '@/src/server/pilot/floorHours';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const ADMIN_ROLES = ['organization_admin', 'admin'] as const;

// Per-person detail plus the adjustment trail -- admin-only, unlike the
// sibling public route. GET reads pilot.v_floor_hours_admin; POST appends
// a correction (see floorHours.ts's own header: this route never edits
// or deletes a recorded activity row).
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);

    const { searchParams } = new URL(request.url);
    const rows = await getFloorHoursAdmin(principal.organizationId, {
      personAccountId: searchParams.get('person_account_id') ?? undefined,
      athleteId: searchParams.get('athlete_id') ?? undefined,
      activityDomain: searchParams.get('activity_domain') ?? undefined,
    });
    return NextResponse.json({ floor_hours: rows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);

    const body = (await request.json()) as {
      activity_id?: string;
      delta_minutes?: number;
      reason?: string;
    };

    if (!body.activity_id || typeof body.delta_minutes !== 'number' || !body.reason?.trim()) {
      throw new Error('Missing activity_id, delta_minutes, or reason');
    }

    const adjustment = await recordActivityAdjustment({
      organizationId: principal.organizationId,
      activityId: body.activity_id,
      deltaMinutes: body.delta_minutes,
      reason: body.reason.trim(),
      adjustedByAccountId: principal.accountId,
      adjustedByRole: principal.role,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'activity_log_adjustment',
      entity_id: adjustment.adjustment_id,
      details: { activity_id: adjustment.activity_id, delta_minutes: adjustment.delta_minutes },
    });

    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
