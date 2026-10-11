import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { getOrganizationClearedTonight } from '@/src/server/pilot/clearedTonight';

export const runtime = 'nodejs';

/**
 * Capability #151: THE ORG-WIDE WAIVER COMPLIANCE VIEW.
 *
 * admin/consent/page.tsx already lets staff look up one athlete's waivers
 * at a time; this is the missing rollup -- which athletes are missing
 * which waiver type, across the whole roster, in one screen. Read-only.
 *
 * Each row also carries `tonight`: the one cleared-tonight answer for that
 * athlete and the records it rests on (clearedTonight.ts, OD-2026-10-08-006
 * A-Q19). Same roles, same roster; nothing here refuses or allows anything.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const items = await getOrganizationClearedTonight(principal.organizationId);

    return NextResponse.json({
      ok: true,
      items: items.map((item) => ({
        athlete_id: item.athleteId,
        athlete_name: item.athleteName,
        active_flag: item.activeFlag,
        waivers: item.waivers,
        tonight: item.tonight,
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
