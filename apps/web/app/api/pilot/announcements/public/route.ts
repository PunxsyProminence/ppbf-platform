import { NextResponse, type NextRequest } from 'next/server';

import { listAnnouncements } from '@/src/server/pilot/announcements';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Unauthenticated read of the latest gym notices for the *default* pilot org.
 * Used by the login page Gym Notice panel.
 *
 * Security: never accepts caller-supplied organization_id (audit finding).
 * Always scopes to PPBF_PILOT_DEFAULT_ORG_ID / ppbf-default-org.
 * Returns only public-safe fields already present on PilotAnnouncement.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawLimit = Number(searchParams.get('limit') ?? '3');
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 8)) : 3;

    const organizationId = getPilotDefaultOrganizationId();
    const announcements = await listAnnouncements(organizationId, limit);

    return NextResponse.json({
      ok: true,
      organization_id: organizationId,
      announcements,
    });
  } catch (error) {
    return jsonError(error);
  }
}
