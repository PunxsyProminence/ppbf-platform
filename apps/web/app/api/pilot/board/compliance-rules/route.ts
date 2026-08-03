import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getComplianceRulesByCategory } from '@/src/server/pilot/compliance';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * The standard a gym holds itself to, for the board seat accountable for it.
 *
 * Rules only: name, category, severity, escalation level. No violation, no
 * athlete, no count -- so this carries nothing the aggregate-only boundary
 * suppresses, and needs no cohort floor. What a gym has WRITTEN DOWN is not a
 * measurement of anybody.
 *
 * Rules are policy, not enforcement: detection_logic is descriptive prose and
 * nothing evaluates it, so this route deliberately does not return that column
 * -- a board reading executable-looking logic would reasonably conclude
 * something runs it.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board', 'platform_owner']);

    const rules = await getComplianceRulesByCategory(principal.organizationId);

    return NextResponse.json(
      { ok: true, rules },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
