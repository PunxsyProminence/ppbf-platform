import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { disconnectGymTv } from '@/src/server/pilot/gymTvs';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ tvId: string }>;
}

// Disconnect a TV: its key is refused from now on and any session on it is taken off. Staff only,
// same two roles as the list. Any coach may disconnect any of the gym's TVs -- they are shared
// gym TVs, not personal ones (Jason "A", 2026-10-06), and the cut-off has to be immediate when a
// TV goes missing. A TV outside the caller's organization is a 404, like one that never existed.
const STAFF_ROLES = ['coach', 'organization_admin'] as const;

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);
    const { tvId } = await context.params;
    if (typeof tvId !== 'string' || tvId.trim() === '') {
      return NextResponse.json({ error: 'TV_ID_REQUIRED' }, { status: 400 });
    }
    const tv = await disconnectGymTv(principal.organizationId, tvId);
    return NextResponse.json({ tv });
  } catch (error) {
    return jsonError(error);
  }
}
