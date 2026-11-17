import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { BEHAVIOR_KPI_READER_ROLES, listBehaviorKpis } from '@/src/server/pilot/behaviorKpis';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The two behavioural KPI lists the coach drill page shows side by side
// (OD-2026-11-16-003 ruling 1; lane CAT-d). Read only. The roles are the drill
// page's own (app/coach/drills/page.tsx RoleSessionGate ['coach', 'admin'],
// 'admin' covering organization_admin and admin); the organization is always
// the session's. Coaching content, no athlete data.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...BEHAVIOR_KPI_READER_ROLES]);
    const lists = await listBehaviorKpis(principal.organizationId);
    return NextResponse.json({ lists });
  } catch (error) {
    return jsonError(error);
  }
}
