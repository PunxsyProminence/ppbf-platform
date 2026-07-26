import { NextResponse, type NextRequest } from 'next/server';

import { createAnnouncement, isAllowedAnnouncementRole } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

function mapPrincipalRoleToAnnouncementRole(role: string): 'admin' | 'coach' | null {
  if (role === 'organization_admin' || role === 'admin' || role === 'platform_owner') {
    return 'admin';
  }
  if (role === 'coach') {
    return 'coach';
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json()) as {
      message?: string;
      author_name?: string;
      author_role?: string;
      access_pin?: string;
    };

    const organizationId = principal.organizationId;
    const message = body.message?.trim() || '';
    const authorName = principal.accountId;
    const authorRole = mapPrincipalRoleToAnnouncementRole(principal.role);

    if (!message) {
      throw new Error('Missing message');
    }

    if (!authorRole || !isAllowedAnnouncementRole(authorRole)) {
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
