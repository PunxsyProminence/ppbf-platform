import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  isAnnouncementKind,
  isAnnouncementPlacement,
  listAnnouncements,
  listLiveAnnouncements,
} from '@/src/server/pilot/announcements';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      placement?: string;
      kind?: string;
      view?: string;
    };

    // The authoring view is the only read that returns items nobody may see
    // yet: scheduled, expired, and retired ones. It is restricted to the roles
    // that may author, so a member cannot read a notice before it goes live.
    if (body.view === 'authoring') {
      requireRole(principal, ['platform_owner', 'organization_admin', 'admin', 'coach', 'board']);

      const announcements = await listAnnouncements(principal.organizationId, body.limit ?? 25);

      return NextResponse.json({
        ok: true,
        organization_id: principal.organizationId,
        announcements,
      });
    }

    const placement = body.placement ?? 'gym_notices';
    const kind = body.kind ?? 'notice';

    if (!isAnnouncementPlacement(placement) || !isAnnouncementKind(kind)) {
      throw new Error('Unsupported placement or kind');
    }

    const announcements = await listLiveAnnouncements(principal.organizationId, {
      placement,
      kind,
      limit: body.limit ?? 8,
    });

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      announcements,
    });
  } catch (error) {
    return jsonError(error);
  }
}
