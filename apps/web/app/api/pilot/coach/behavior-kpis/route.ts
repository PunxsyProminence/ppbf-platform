import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { listBehaviorKpis } from '@/src/server/pilot/behaviorKpis';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The two behavioural KPI lists the coach drill page shows side by side
// (OD-2026-11-16-003 ruling 1; lane CAT-d). Read only. The role check is the
// drill library's own (app/api/pilot/drills/route.ts GET:
// COACHING_CONTENT_READER_ROLES, coachingContentAccess.ts), shared, not a list
// of this route's (Overwatch); the organization is always the session's.
// Coaching content, no athlete data, nothing to narrow for an athlete.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);
    const lists = await listBehaviorKpis(principal.organizationId);
    return NextResponse.json({ lists });
  } catch (error) {
    return jsonError(error);
  }
}
