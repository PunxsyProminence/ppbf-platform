import { NextResponse, type NextRequest } from 'next/server';

import {
  createAnnouncement,
  isAllowedAnnouncementRole,
  type AnnouncementAuthorRole,
} from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import type { PilotRole } from '@/src/server/pilot/contracts';

export const runtime = 'nodejs';

// The author role written onto an announcement is a public claim about who is
// speaking for the club, so it is constrained by the caller's session role
// rather than taken from the request body. Board seats are finer-grained than
// PilotRole, so a board principal may still pick which seat it is posting as --
// but only from the board seats, and no other role can claim one.
function resolveAuthorRole(principalRole: PilotRole, requested: string): AnnouncementAuthorRole | null {
  if (principalRole === 'coach') {
    return 'coach';
  }

  if (principalRole === 'platform_owner' || principalRole === 'organization_admin' || principalRole === 'admin') {
    return 'admin';
  }

  if (principalRole === 'board') {
    return isAllowedAnnouncementRole(requested) && requested.startsWith('board-') ? requested : null;
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    const body = (await request.json()) as {
      message?: string;
      author_name?: string;
      author_role?: string;
    };

    const organizationId = principal.organizationId;
    const message = body.message?.trim() || '';
    const authorName = body.author_name?.trim() || '';
    const authorRole = resolveAuthorRole(principal.role, body.author_role?.trim() || '');

    if (!message) {
      throw new Error('Missing message');
    }

    if (!authorName) {
      throw new Error('Missing author_name');
    }

    if (!authorRole) {
      throw new Error('Forbidden: role not allowed to post announcements');
    }

    const announcement = await createAnnouncement({
      organizationId,
      message,
      authorName,
      authorRole,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'announcement',
      entity_id: announcement.announcement_id,
      details: {
        author_name: authorName,
        author_role: authorRole,
      },
    });

    return NextResponse.json({ ok: true, organization_id: organizationId, announcement });
  } catch (error) {
    return jsonError(error);
  }
}
