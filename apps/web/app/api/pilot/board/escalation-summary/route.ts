import { NextResponse, type NextRequest } from 'next/server';

import { getBoardEscalationSummary } from '@/src/server/pilot/escalationLadder';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The board's ONLY window into the escalation ladder, mirroring
// board/compliance-summary exactly: count-only buckets, k-anonymity-gated in
// getBoardEscalationSummary via boardCountMetric, never a row, never a name.
// Board is 403'd from /api/pilot/escalations itself
// (boardRoleBoundaries.test.ts) -- this route is why that refusal is not
// "board learns nothing": it learns how many, never who.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board']);

    const summary = await getBoardEscalationSummary(principal.organizationId);

    return NextResponse.json(
      { ok: true, summary },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
