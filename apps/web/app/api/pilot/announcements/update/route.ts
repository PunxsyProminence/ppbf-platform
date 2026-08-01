import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { setAnnouncementActive } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Retire and restore. The role set matches the one that may post, and the
// update is scoped to the caller's organization, so a coach at one gym cannot
// pull a notice down at another.
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin', 'coach', 'board']);

    const body = (await request.json()) as {
      announcement_id?: string;
      active?: boolean;
    };

    const announcementId = body.announcement_id?.trim() || '';
    if (!announcementId) {
      throw new Error('Missing announcement_id');
    }

    if (typeof body.active !== 'boolean') {
      throw new Error('Missing active');
    }

    const announcement = await setAnnouncementActive({
      organizationId: principal.organizationId,
      announcementId,
      active: body.active,
    });

    if (!announcement) {
      throw new Error('Not found');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'announcement',
      entity_id: announcement.announcement_id,
      details: {
        active: announcement.active,
        placement: announcement.placement,
        kind: announcement.kind,
      },
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, announcement });
  } catch (error) {
    return jsonError(error);
  }
}
