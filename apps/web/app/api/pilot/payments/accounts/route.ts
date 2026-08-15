import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listPaymentAccounts } from '@/src/server/pilot/paymentConnect';

export const runtime = 'nodejs';

// The payments settings page's read: this organization's two lane slots.
// Account IDs are identifiers, not credentials -- no secret exists in this
// table to leak. Admin-scoped like the rest of payment configuration.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const items = await listPaymentAccounts(principal.organizationId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
