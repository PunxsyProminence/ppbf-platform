import { NextResponse, type NextRequest } from 'next/server';

import { getOrganizationViolationSummary } from '@/src/server/pilot/compliance';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board']);

    const status = request.nextUrl.searchParams.get('status');

    if (status && !['new', 'acknowledged', 'escalated', 'resolved', 'dismissed'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status parameter' }, { status: 400 });
    }

    // This endpoint serves the board principal and no other, so the aggregate
    // floor is not an option the caller passes in.
    const summary = await getOrganizationViolationSummary(principal.organizationId, {
      audience: 'board',
      status: status || undefined,
    });

    return NextResponse.json(
      { ok: true, summary, statusFilter: status || 'all' },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
