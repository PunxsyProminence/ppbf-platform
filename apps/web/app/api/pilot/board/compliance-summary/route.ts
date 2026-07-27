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

    const summary = await getOrganizationViolationSummary(principal.organizationId, status || undefined);

    return NextResponse.json({ ok: true, summary, statusFilter: status || 'all' });
  } catch (error) {
    return jsonError(error);
  }
}
