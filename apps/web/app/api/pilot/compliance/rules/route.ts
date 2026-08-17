import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getComplianceRulesByCategory } from '@/src/server/pilot/compliance';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Active compliance rules for the caller's own organization, for a coach or
 * admin to pick from when filing a new violation (e.g. escalating a Film
 * Study observation) -- the same read board/compliance-rules/route.ts already
 * serves the board, gated to the coach/admin audience instead. Rules only:
 * no violation, no athlete.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const rules = await getComplianceRulesByCategory(principal.organizationId);

    return NextResponse.json(
      { ok: true, rules },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
