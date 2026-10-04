import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import { listRecentCheckIns } from '@/src/server/pilot/athleteCheckIns';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Map item 20: staff read of ONE athlete's recent sleep hours, for the trend
// on the coach's wellness panel. A sibling of /api/pilot/coach/athlete-check-in
// rather than a widening of it: that route's body is pinned to `{ today }`.
//
// Same audience and same gates as that route: any coach or organization admin
// in the athlete's own organization, and assertAthleteBelongsToOrganization
// refuses another gym's athlete and a soft-deleted one alike, before any
// check-in row is read. The organization is the session's, never a parameter.
//
// SLEEP ONLY, AND NOTHING DERIVED. Each item is the day and the hours the
// athlete reported, newest first; a skipped question stays null. No average,
// no band, no advice.

const SLEEP_TREND_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export const SLEEP_TREND_LIMIT = 14;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SLEEP_TREND_READ_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);

    const rows = await listRecentCheckIns(principal.organizationId, athleteId, SLEEP_TREND_LIMIT);
    const items = rows.map((row) => ({ checked_in_on: row.checked_in_on, sleep_hours: row.sleep_hours }));
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
