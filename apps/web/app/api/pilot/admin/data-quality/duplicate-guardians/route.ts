import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { findDuplicateGuardianGroups } from '@/src/server/pilot/duplicateGuardians';

export const runtime = 'nodejs';

// Data-quality read: guardians split across two records in THIS organization.
// Admin-only, read-only. Emails arrive masked from the module (never raw),
// athletes are ids only, and there is deliberately no merge endpoint --
// remediation is a human's call about which family is which.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const items = await findDuplicateGuardianGroups(principal.organizationId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
