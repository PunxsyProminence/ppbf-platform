import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getCoachPassbookGapQueue } from '@/src/server/pilot/passbook';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);

    const coachScope = isOrganizationAdminRole(principal.role) ? null : principal.accountId;
    const items = await getCoachPassbookGapQueue(principal.organizationId, coachScope);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
