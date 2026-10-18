import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getAttendanceLast28Days } from '@/src/server/pilot/attendancePrecedence';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One athlete's attendance over the last 28 days and the days since their
 * last session, from the reconciled class register (OD-2026-10-17-026 (c),
 * Jason: "A: All three (Rec.)"; coaches only = coach + organization_admin +
 * admin, Overwatch's GO to L60).
 *
 *   GET ?athlete_id=   { ok, attendance: AthleteAttendanceWindow }
 *
 * GATE: a staff role (the session's membership role), then the athlete
 * chokepoint. Athletes, guardians, board and platform owner are refused by
 * requireRole before anything is read. Read-only.
 */

const ATTENDANCE_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ATTENDANCE_ROLES]);
    const athleteId = (request.nextUrl.searchParams.get('athlete_id') ?? '').trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);
    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    const windows = await getAttendanceLast28Days(principal.organizationId, [athleteId], today);
    return NextResponse.json(
      { ok: true, attendance: windows.get(athleteId) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
