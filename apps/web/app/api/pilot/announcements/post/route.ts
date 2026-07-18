import { NextResponse, type NextRequest } from 'next/server';

import { createAnnouncement, isAllowedAnnouncementRole } from '@/src/server/pilot/announcements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      organization_id?: string;
      message?: string;
      author_name?: string;
      author_role?: string;
      access_pin?: string;
    };

    const organizationId = body.organization_id?.trim() || getPilotDefaultOrganizationId();
    const message = body.message?.trim() || '';
    const authorName = body.author_name?.trim() || '';
    const authorRole = body.author_role?.trim() || '';
    const accessPin = body.access_pin?.trim() || '';

    if (!message) {
      throw new Error('Missing message');
    }

    if (!authorName) {
      throw new Error('Missing author_name');
    }

    if (!isAllowedAnnouncementRole(authorRole)) {
      throw new Error('Forbidden: role not allowed to post announcements');
    }

    const requiredPin = process.env.PPBF_OPERATOR_PIN?.trim();
    if (!requiredPin) {
      throw new Error('Server misconfiguration: PPBF_OPERATOR_PIN is required');
    }
    if (!accessPin || accessPin !== requiredPin) {
      throw new Error('Forbidden: invalid access PIN');
    }

    const announcement = await createAnnouncement({
      organizationId,
      message,
      authorName,
      authorRole,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: null,
      actor_role: null,
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
