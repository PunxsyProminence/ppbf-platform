import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { listAnnouncements } from '@/src/server/pilot/announcements';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { organization_id?: string; limit?: number };

    const organizationId = body.organization_id?.trim() || getPilotDefaultOrganizationId();
    const announcements = await listAnnouncements(organizationId, body.limit ?? 8);

    return NextResponse.json({
      ok: true,
      organization_id: organizationId,
      announcements,
    });
  } catch (error) {
    return jsonError(error);
  }
}
