import { NextResponse, type NextRequest } from 'next/server';

import { resolvePaymentSetupStatus } from '@/src/server/pilot/paymentSetup';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Setup progress only. This route reports how far payment configuration has
// got; it moves no money and exposes no processor credential. Admin-scoped
// because the steps it lists are administrative work, and because an athlete
// or parent has no use for a half-finished setup checklist.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);

    return NextResponse.json(resolvePaymentSetupStatus(), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
