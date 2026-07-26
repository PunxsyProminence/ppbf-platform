import { NextResponse, type NextRequest } from 'next/server';

import { createAnnouncement, isAllowedAnnouncementRole } from '@/src/server/pilot/announcements';
import { resolvePrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      organization_id?: string;
      message?: string;
      author_name?: string;
      author_role?: string;
    };

    const principal = await resolvePrincipal(request);
    if (!principal) {
      throw new Error('Unauthorized: login required');
    }

    if (body.organization_id && body.organization_id.trim() !== principal.organizationId) {
      throw new Error('Forbidden: organization mismatch');
    }

    const organizationId = principal.organizationId;
    const message = body.message?.trim() || '';
    const authorName = body.author_name?.trim() || '';
    const authorRole = body.author_role?.trim() || '';

    if (!message) {
      throw new Error('Missing message');
    }

    if (!authorName) {
      throw new Error('Missing author_name');
    }

    if (!isAllowedAnnouncementRole(authorRole)) {
      throw new Error('Forbidden: role not allowed to post announcements');
    }

    if (principal.authProvider !== 'microsoft') {
      throw new Error('Forbidden: Microsoft authentication required');
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
