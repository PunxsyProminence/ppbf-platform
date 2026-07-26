import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listAnnouncements } from '@/src/server/pilot/announcements';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json().catch(() => ({}))) as { limit?: number };

    const organizationId = principal.organizationId;
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
