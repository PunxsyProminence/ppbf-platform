import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { attendanceOnDay } from '@/src/server/pilot/attendancePrecedence';
import {
  coachAuthorizedRoster,
  organizationActionableRoster,
} from '@/src/server/pilot/coachAthleteRoster';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { gymDayIso } from '@/src/lib/gymTime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who is marked on the floor today, for the athletes this staff member may see.
 *
 * THE COACH WORKSPACE HAS SHOWN "Unknown" FOR EVERY ATHLETE SINCE IT WAS
 * BUILT, because `attendance` was hardcoded there -- the roster carried the
 * field with no feed behind it. This is the feed. It reads
 * pilot.attendance_reconciled, which is CT-13's system of record for
 * athlete-day participation: activity_log (boxing rows) beats
 * scheduler_attendance beats the legacy table, highest available source wins
 * OUTRIGHT, and sources are never summed. Reading a source table directly
 * here -- or reading two and combining them -- is the participation
 * double-count that view exists to prevent.
 *
 * TODAY IS COMPUTED HERE, IN GYM TIME, AND IS NOT TAKEN FROM THE REQUEST.
 * Two reasons and both matter. A client-supplied day is a parameter a caller
 * can steer, and this response is about children; and a day computed from a
 * browser clock is whatever timezone that laptop is set to, which for an
 * evening session is routinely tomorrow. The view resolves scheduler
 * timestamps in America/New_York for the same reason, so the question and the
 * data agree about what day it is.
 *
 * A ROW MEANS A MARK. NO ROW MEANS NO MARK -- NOT ABSENCE. Before the
 * register is taken, every athlete in the gym has no row, and this route
 * returns marks only. It never synthesises 'absent' for the silent ones,
 * because "nobody wrote anything down yet" and "this child did not come to
 * training" are different claims and only one of them has evidence. The
 * surface names that state itself.
 *
 * The roster is the same one the picker uses, through the same contract: a
 * coach gets athleteIdsForCoach (coach of record UNION active, unexpired
 * coverage), an organization admin gets the organization's actionable roster.
 * No role is broadened here, and the athlete ids are never taken from the
 * request -- a caller who could name them could name someone else's child.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const roster = principal.role === 'coach'
      ? await coachAuthorizedRoster(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        ? await organizationActionableRoster(principal.organizationId)
        : [];

    const day = gymDayIso();
    if (!day) {
      // Unreachable in practice; a null here would otherwise become a query
      // for "no day", and this route must not answer with an empty list it
      // did not establish.
      throw new Error('ATTENDANCE_DAY_UNRESOLVED');
    }

    const marks = await attendanceOnDay(
      principal.organizationId,
      roster.map((athlete) => athlete.athlete_id),
      day,
    );

    /* `covered` is not decoration and it is not the same list as `marks`.
       The workspace roster comes from /api/pilot/athletes/list, which returns
       EVERY athlete in the organization to a coach and merely redacts dob and
       emergency_contact for the ones they are unrelated to -- it is a display
       projection and says so. This route asks the access contract instead, so
       it is deliberately NARROWER.

       Without saying which athletes it covered, a caller cannot tell "this
       athlete has no mark today" from "nobody asked about this athlete", and
       the workspace rendered both as "No mark yet" -- a claim that the
       platform looked, about a child it never looked at. Naming the covered
       set is what lets the surface keep those apart. */
    return NextResponse.json(
      { ok: true, day, covered: roster.map((athlete) => athlete.athlete_id), marks },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
