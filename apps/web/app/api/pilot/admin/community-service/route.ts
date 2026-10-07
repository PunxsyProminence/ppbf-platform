import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getCommunityServiceTotals } from '@/src/server/pilot/communityService';

export const runtime = 'nodejs';

// Community service tracker (module 128). Read-only over the
// community_service rows in the activity log; recording service stays on
// the activity-log write path, which already requires a verifier for this
// domain. Verified and unverified totals arrive separately and must be
// displayed that way.
//
// A coach receives only the people whose athlete record they reach (coach
// of record or live covering coach, via access.ts inside
// getCommunityServiceTotals); an organization admin receives the whole
// gym. The principal is passed through so that filter runs at the server.

const SERVICE_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SERVICE_ROLES]);

    const params = request.nextUrl.searchParams;
    const items = await getCommunityServiceTotals(principal, {
      personAccountId: params.get('person_account_id')?.trim() || undefined,
      since: params.get('since')?.trim() || undefined,
      until: params.get('until')?.trim() || undefined,
    });
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
