import { NextResponse, type NextRequest } from 'next/server';

import { athleteIdsForCoach, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getCoachPassbookGapQueue } from '@/src/server/pilot/passbook';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);

    // A coach's queue covers every athlete they reach: coach of record UNION
    // active coverage (athleteIdsForCoach; OD-2026-10-05-024 item 2).
    const athleteIds = isOrganizationAdminRole(principal.role)
      ? null
      : await athleteIdsForCoach(principal.organizationId, principal.accountId);
    const items = await getCoachPassbookGapQueue(principal.organizationId, athleteIds);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
