import { NextResponse, type NextRequest } from 'next/server';

import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { getFloorHoursPublic, type FloorHoursPeriodKind } from '@/src/server/pilot/floorHours';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Unauthenticated read of organization-wide floor hours, for a public page.
 * Reads ONLY pilot.v_floor_hours_public through getFloorHoursPublic --
 * that view carries no person or athlete identifier by construction, see
 * the migration's own comment.
 *
 * Security: never accepts caller-supplied organization_id, matching the
 * public announcements route's own audit-finding fix -- always scopes to
 * PPBF_PILOT_DEFAULT_ORG_ID / ppbf-default-org.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const organizationId = getPilotDefaultOrganizationId();
    const rows = await getFloorHoursPublic(organizationId, {
      activityDomain: searchParams.get('activity_domain') ?? undefined,
      periodKind: (searchParams.get('period_kind') as FloorHoursPeriodKind | null) ?? undefined,
    });
    return NextResponse.json({ organization_id: organizationId, floor_hours: rows });
  } catch (error) {
    return jsonError(error);
  }
}
