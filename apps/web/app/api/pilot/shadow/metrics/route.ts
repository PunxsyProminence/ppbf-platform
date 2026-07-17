import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';

export const runtime = 'nodejs';

// GET /api/pilot/shadow/metrics — admin/board only growth dashboard data
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'platform_owner']);

    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get('days') ?? '30', 10);

    const metrics = await getGrowthMetrics(principal.organizationId, days);

    return NextResponse.json({ ok: true, metrics });
  } catch (error) {
    return jsonError(error);
  }
}
