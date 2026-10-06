import { NextResponse, type NextRequest } from 'next/server';

import { athleteIdsForCoach, isOrganizationAdminRole } from '@/src/server/pilot/access';
import {
  getClassAttendanceRoster,
  getOrganizationAttendanceSummary,
  getWeeklyAttendanceTrend,
} from '@/src/server/pilot/attendanceReporting';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getSchedulerClassById } from '@/src/server/pilot/schedulerDb';

export const runtime = 'nodejs';

// Read-only rollup over pilot.scheduler_attendance, for the reporting layer
// #122/#173 had none of before this route: an org-wide per-athlete summary,
// or (with ?class_id=) one class's roster with its recorded attendance.
//
// Scope, deliberately narrow for this first pass:
//   * organization_admin/admin see the whole organization.
//   * coach sees only classes they own (coach_account_id,
//     scheduled_by_account_id, or covering_coach_account_id) -- the same
//     ownership test the scheduler route's own GET already applies -- AND,
//     within those classes, only athletes the coach reaches (assignment of
//     record or a live coverage grant, athleteIdsForCoach). Ownership alone
//     was self-granting: cover_class writes the caller in as covering coach
//     with no approval, so one POST bought any coach every registered
//     athlete's name, attendance and free-text note for any class (CL-A2).
//     The scheduler GET closed the same leak the same way.
//   * athlete, parent, board, volunteer, staff: forbidden here. This is an
//     operations/reporting surface, not a self-service one; a parent- or
//     athlete-facing attendance view is real future work (the Parent/Guardian
//     Dashboard, capability #93/#167) and deserves its own scoping decision
//     rather than reusing this route's shape by default.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;

    const isAdmin = role === 'admin' || isOrganizationAdminRole(role);
    const isCoach = role === 'coach';
    if (!isAdmin && !isCoach) {
      throw new Error('Forbidden: attendance reporting is available to coach and organization_admin/admin only');
    }

    const coachAccountId = isCoach ? principal.accountId : undefined;
    // Looked up only after each branch's own checks pass, so a refused or
    // malformed request costs no extra query. null = not narrowed (admin).
    const coachReach = async (): Promise<Set<string> | null> =>
      isCoach ? new Set(await athleteIdsForCoach(principal.organizationId, principal.accountId)) : null;
    const inReach = <Row extends { athlete_id: string }>(rows: Row[], reachable: Set<string> | null): Row[] =>
      reachable ? rows.filter((row) => reachable.has(row.athlete_id)) : rows;
    const classId = request.nextUrl.searchParams.get('class_id');

    if (classId) {
      const classItem = await getSchedulerClassById(principal.organizationId, classId);
      if (!classItem) {
        throw new Error('Missing class record');
      }
      if (
        isCoach
        && classItem.coach_account_id !== principal.accountId
        && classItem.scheduled_by_account_id !== principal.accountId
        && classItem.covering_coach_account_id !== principal.accountId
      ) {
        throw new Error('Forbidden: coach does not own this class');
      }

      const reachable = await coachReach();
      const roster = await getClassAttendanceRoster(principal.organizationId, classId);
      return NextResponse.json({ ok: true, class_id: classId, roster: inReach(roster, reachable) });
    }

    // #173: a week-over-week trend, distinct from the current-snapshot
    // summary below -- explicit opt-in via ?trend=1 rather than folding
    // both shapes into one response, since a caller wanting the roster
    // snapshot has no use for a second array it must ignore.
    if (request.nextUrl.searchParams.get('trend') === '1') {
      const weeksRaw = request.nextUrl.searchParams.get('weeks');
      const weeks = weeksRaw === null ? undefined : Number(weeksRaw);
      if (weeksRaw !== null && (!Number.isFinite(weeks) || weeks! <= 0)) {
        throw new Error('Unsupported weeks: must be a positive number');
      }
      const reachable = await coachReach();
      const trend = await getWeeklyAttendanceTrend(principal.organizationId, {
        coachAccountId,
        athleteIds: reachable ? [...reachable] : undefined,
        weeks,
      });
      return NextResponse.json({ ok: true, trend });
    }

    const sinceRaw = request.nextUrl.searchParams.get('since');
    // Validated here rather than left to the ::timestamptz cast in
    // attendanceReporting.ts's SQL -- an invalid string would otherwise
    // surface as a raw Postgres "invalid input syntax" error, which
    // jsonError falls through to a generic 500 for. A malformed query
    // param is a caller mistake, not a server fault.
    if (sinceRaw !== null && Number.isNaN(Date.parse(sinceRaw))) {
      throw new Error('Unsupported since: must be a valid date string');
    }
    const sinceIso = sinceRaw ?? undefined;
    const reachable = await coachReach();
    const summary = await getOrganizationAttendanceSummary(principal.organizationId, {
      coachAccountId,
      sinceIso,
    });

    return NextResponse.json({ ok: true, athletes: inReach(summary, reachable) });
  } catch (error) {
    return jsonError(error);
  }
}
