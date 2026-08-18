import { NextResponse, type NextRequest } from 'next/server';

import { getBoardExternalCompetitionSummary } from '@/src/server/pilot/externalCompetition';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The board's ONLY window into external competition activity, mirroring
// board/escalation-summary and board/compliance-summary exactly:
// competition-status counts plus a k-anonymity-gated win/loss aggregate.
// Board is 403'd from /api/pilot/operations/external-competition/* itself
// (COMPETITION_READ_ROLES in externalCompetition.ts does not include
// 'board'; boardRoleBoundaries.test.ts holds that) -- this route is why
// that refusal is not "board learns nothing".
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board']);

    const summary = await getBoardExternalCompetitionSummary(principal.organizationId);

    return NextResponse.json(
      { ok: true, summary },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
