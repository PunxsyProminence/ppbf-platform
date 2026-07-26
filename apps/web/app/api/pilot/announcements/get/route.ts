import { NextResponse, type NextRequest } from 'next/server';

import { jsonError } from '@/src/server/pilot/http';
import { listAnnouncements } from '@/src/server/pilot/announcements';
import { resolvePrincipal } from '@/src/server/pilot/auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { organization_id?: string; limit?: number };
    const principal = await resolvePrincipal(request);

    if (!principal) {
      throw new Error('Unauthorized: login required');
    }

    if (body.organization_id && body.organization_id.trim() !== principal.organizationId) {
      throw new Error('Forbidden: organization mismatch');
    }

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
