import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { classesRunningNow, floored, registerTotalToday } from '@/src/server/pilot/floorCount';
import { listLiveTvRounds } from '@/src/server/pilot/gymTvs';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What is running on the floor now, and how many are here (lane W4-3, FN-4a; Q12 A as App Overwatch
 * applied it; GO on #2192, 7206014991). No name, initials or id of anyone, on any branch.
 *
 *   GET, board                   { ok, read_at, classes: [{ title, start_at, end_at, room }], rounds, total }
 *   GET, staff, volunteer        { ok, read_at, classes: [{ title, start_at, end_at, room, count }], rounds }
 *   GET, coach and gym admin     { ok, read_at, classes: [{ title, start_at, end_at, room }], rounds }
 *
 *   rounds: [{ tv_name, phase, round, rounds_total, is_paused }], one per TV showing a session with a round
 *           clock (QE A); a session sent to two TVs is listed under each
 *   total:  { status: 'available', count } from 5 up; { status: 'insufficient_data', count: null } for 0 to 4 (flag 3)
 *
 * The board gets one floored total and no count per class (flags 3 and 4). Staff-role and volunteer
 * accounts get each class's exact count and no total (flag 2). Coaches and gym admins get neither:
 * their line counts the names beside it (QG A). Counts are register-only (floorCount.ts, flag 12).
 * read_at is when this was read, so the page shows the round as read, with the time (QF A).
 *
 * GATE (approved by name in the GO): the six roles below; the gym is the session's, never the
 * request's, and query fields are refused. The platform owner is refused: this read reaches the
 * session-run tables through the round read, which OD-2026-10-07-011 ruling 2 took the platform owner
 * off; its floored total comes through its own route (QC A). Parents and athletes have their own line.
 */

const CLASSES_LINE_READ_ROLES = ['board', 'staff', 'volunteer', 'coach', 'organization_admin', 'admin'] as const;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const CLASS_KEYS = ['title', 'start_at', 'end_at', 'room'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CLASSES_LINE_READ_ROLES]);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const now = new Date();
    const organizationId = principal.organizationId;
    const isBoard = principal.role === 'board';
    const countsEachClass = principal.role === 'staff' || principal.role === 'volunteer';
    const [classes, rounds, total] = await Promise.all([
      classesRunningNow(organizationId, now),
      listLiveTvRounds(organizationId, now),
      isBoard ? registerTotalToday(organizationId, now) : Promise.resolve(null),
    ]);
    const body = {
      ok: true,
      read_at: now.toISOString(),
      classes: classes.map((item) => {
        const shown: Record<string, unknown> = Object.fromEntries(CLASS_KEYS.map((key) => [key, item[key]]));
        if (countsEachClass) shown.count = item.count;
        return shown;
      }),
      rounds: rounds.map(({ tv_name, phase, round, rounds_total, is_paused }) => ({
        tv_name,
        phase,
        round,
        rounds_total,
        is_paused,
      })),
      ...(isBoard && total !== null ? { total: floored(total) } : {}),
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}
