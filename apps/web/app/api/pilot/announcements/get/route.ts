import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listAnnouncements } from '@/src/server/pilot/announcements';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json().catch(() => ({}))) as { limit?: number };

    const announcements = await listAnnouncements(principal.organizationId, body.limit ?? 8);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      announcements,
    });
  } catch (error) {
    return jsonError(error);
  }
}
