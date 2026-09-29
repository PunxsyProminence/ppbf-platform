import { NextResponse, type NextRequest } from 'next/server';

import { getComplianceRulesByCategory } from '@/src/server/pilot/compliance';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * This gym's active compliance rules, for the people who file violations
 * against them.
 *
 * POST /api/pilot/compliance/violations has always required a rule_id, and
 * the only rules read that existed was the board's (board/compliance-rules),
 * which a coach or organization admin cannot reach. So the write path was
 * reachable only by someone who already knew a rule id -- nothing in the app
 * could file a violation at all.
 *
 * Gated to exactly the roles that may file (the violations POST gate), no
 * wider: this read exists to serve that write. platform_owner is absent for
 * the same reason it is absent there.
 *
 * Rules only -- name, category, severity, escalation level. No violation, no
 * athlete. detection_logic is not selected by getComplianceRulesByCategory:
 * it is descriptive prose nothing evaluates, and a coach reading
 * executable-looking logic would reasonably conclude something runs it.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const rules = await getComplianceRulesByCategory(principal.organizationId);

    return NextResponse.json(
      { ok: true, rules },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
