import { NextResponse, type NextRequest } from 'next/server';

import { getBoardWrestlingLeagueSummary } from '@/src/server/pilot/wrestlingLeague';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The board's ONLY window into the wrestling league, mirroring
// board/escalation-summary and board/compliance-summary exactly:
// season-status counts plus a k-anonymity-gated rostered-athlete count.
// Board is 403'd from /api/pilot/operations/wrestling-league/* itself
// (LEAGUE_READ_ROLES in wrestlingLeague.ts does not include 'board';
// boardRoleBoundaries.test.ts holds that) -- this route is why that refusal
// is not "board learns nothing".
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board']);

    const summary = await getBoardWrestlingLeagueSummary(principal.organizationId);

    return NextResponse.json(
      { ok: true, summary },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
