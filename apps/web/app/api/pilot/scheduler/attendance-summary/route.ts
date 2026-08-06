import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import {
  getClassAttendanceRoster,
  getOrganizationAttendanceSummary,
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
//     ownership test the scheduler route's own GET already applies.
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

      const roster = await getClassAttendanceRoster(principal.organizationId, classId);
      return NextResponse.json({ ok: true, class_id: classId, roster });
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
    const summary = await getOrganizationAttendanceSummary(principal.organizationId, {
      coachAccountId,
      sinceIso,
    });

    return NextResponse.json({ ok: true, athletes: summary });
  } catch (error) {
    return jsonError(error);
  }
}
