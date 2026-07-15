import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listReviewQueue } from '@/src/server/pilot/intake';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'parent']);

    const queue = await listReviewQueue(principal.organizationId);

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      queue,
    });
  } catch (error) {
    return jsonError(error);
  }
}
