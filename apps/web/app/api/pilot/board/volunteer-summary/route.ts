import { NextResponse, type NextRequest } from 'next/server';

import { getBoardVolunteerSummary } from '@/src/server/pilot/volunteers';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The board's ONLY window into the volunteer roster, mirroring
// board/escalation-summary and board/compliance-summary exactly: count-only
// buckets, k-anonymity-gated in getBoardVolunteerSummary via
// boardCountMetric, never a name, never account_id, never a certification or
// background-check status, never a note. Board is not admitted to
// /api/admin/volunteers itself -- this route is the aggregate substitute,
// closing the capability-network audit finding that the Community &
// Development Director board seat lists "volunteer engagement" and
// "volunteer participation trends" as responsibilities with no API path to
// the volunteer roster at all.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['board']);

    const summary = await getBoardVolunteerSummary(principal.organizationId);

    return NextResponse.json(
      { ok: true, summary },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
