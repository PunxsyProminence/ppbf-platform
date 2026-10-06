import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { setAnnouncementActive } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Retire and restore. The role set matches the one that may post, and the
// update is scoped to the caller's organization, so a coach at one gym cannot
// pull a notice down at another. Within the organization only the notice's
// author or an organization admin may change it (CL-A8; see
// setAnnouncementActive): before that, any coach or board member could pull
// down an admin's or the board's notice. Someone else's notice reads as not
// found.
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
      onlyAuthorAccountId: isOrganizationAdminRole(principal.role) ? null : principal.accountId,
    });

    if (!announcement) {
      throw new Error(
        'Not found: no such notice, or it is not yours to change -- only its author or an organization admin may retire or restore it',
      );
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
