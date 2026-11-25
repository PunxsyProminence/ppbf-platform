import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  listPresentAthletes,
  setRunAthletePresent,
  staffPermittedAthletes,
} from '@/src/server/pilot/sessionRunAthletes';
import { SessionScriptRunError } from '@/src/server/pilot/sessionScriptRuns';
import { readStaffHoldWarning } from '@/src/server/pilot/trainingHolds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// Who is in a session (audit finding F-067).
//
//   GET                              the athletes marked present in this run, by name, and the
//                                    gym's athletes the caller may mark (the live screen's picker)
//   POST { athlete_id, present }     mark one present, or take the mark back
//        optional tapped_ms_ago        whole milliseconds since the coach tapped, for a tap kept in
//                                     the open page and sent late (W4 item 7). On a tied session
//                                     the register then treats it as a tap made that long ago, so
//                                     an Absent or Excused set after it wins (OD-2026-10-21-004
//                                     ruling 1). Without it the tap counts as made now, as before.
//
// STAFF ONLY, like every other route under runs/: coach, organization admin and the legacy admin
// name. platform_owner is refused (running a session is gym work, OD-2026-10-08-003 R2), and so
// are athlete, parent, board and every other role: who was in a session is a staff record with no
// athlete or parent view (OD-2026-10-10-003 items 3 and 4).
//
// THE WRITE IS THE DELIVERING COACH'S, WHILE THE RUN IS LIVE, decided in the module with the
// run row locked; another coach's run answers exactly like a missing one. The module also
// requires the caller to be staff HERE and to reach the athlete, with one refusal for every
// reason, so the answer says nothing about an athlete id.
//
// THE READ NAMES ONLY ATHLETES THE CALLER MAY REACH: the live athletes of the caller's own gym
// (a coach's reach is the whole gym, OD-2026-10-11-007). The ids are computed on the server and
// are never taken from the request; the module filters on them in SQL. A run id of another gym,
// or one that does not exist, simply has nobody in it.
//
// A mark is session detail, not attendance (CT-13, docs/current/ATTENDANCE_PRECEDENCE.md), EXCEPT
// on a session tied to a class (D4, OD-2026-10-21-002): there the same tap writes that class's
// register, and `register` in the answer says what it did (created, already_present, flipped with
// the previous status, skipped with the reason, removed or kept on an untap). A register mark
// written for a held athlete carries the hold warning the register's own check-in gives
// (OD-2026-10-06-024 ruling 1: warn, never block).
const RUN_ROLES = ['coach', 'admin', 'organization_admin'] as const;

const NUL = '\u0000';

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

// A day at most: the page drops what it keeps at sign-out, and the role cache lasts 8 hours.
const TAPPED_MS_AGO_MAX = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RUN_ROLES]);
    const { runId } = await context.params;
    if (!runId.trim() || runId.includes(NUL)) return badRequest('RUN_ID_INVALID');

    const gym = await staffPermittedAthletes(principal);
    const present = await listPresentAthletes(principal.organizationId, [runId], gym.map((athlete) => athlete.athlete_id));
    return NextResponse.json(
      {
        present: present.map(({ athlete_id, full_name, marked_at }) => ({ athlete_id, full_name, marked_at })),
        // The picker: the same set, id and name only (OD-2026-10-11-007, a coach's reach is the whole gym).
        gym: gym.map(({ athlete_id, full_name }) => ({ athlete_id, full_name })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RUN_ROLES]);
    const { runId } = await context.params;
    if (!runId.trim() || runId.includes(NUL)) return badRequest('RUN_ID_INVALID');

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('INVALID_BODY');
    }
    const record = body as Record<string, unknown>;
    const extras = Object.keys(record).filter((key) => !['athlete_id', 'present', 'tapped_ms_ago'].includes(key));
    if (extras.length > 0) {
      return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
    }
    const athleteId = typeof record.athlete_id === 'string' ? record.athlete_id.trim() : '';
    if (athleteId === '' || athleteId.includes(NUL)) {
      return badRequest('athlete_id');
    }
    if (typeof record.present !== 'boolean') {
      return badRequest('present');
    }
    const tappedMsAgo = record.tapped_ms_ago;
    if (
      tappedMsAgo !== undefined
      && (typeof tappedMsAgo !== 'number' || !Number.isSafeInteger(tappedMsAgo) || tappedMsAgo < 0 || tappedMsAgo > TAPPED_MS_AGO_MAX)
    ) {
      return badRequest('tapped_ms_ago');
    }

    const { outcome, register } = await setRunAthletePresent({
      actor: {
        accountId: principal.accountId,
        role: principal.role,
        organizationId: principal.organizationId,
        athleteId: principal.athleteId,
      },
      runId,
      athleteId,
      present: record.present,
      // The server's clock less the page's count since the tap; no clock on the tablet is read.
      ...(tappedMsAgo === undefined ? {} : { tappedAt: new Date(Date.now() - tappedMsAgo).toISOString() }),
    });
    const holdWarning = register?.effect === 'created' || register?.effect === 'flipped'
      ? await readStaffHoldWarning(principal.role, principal.organizationId, athleteId)
      : null;
    return NextResponse.json({
      outcome,
      athlete_id: athleteId,
      present: record.present,
      ...(register ? { register } : {}),
      ...(holdWarning ? { hold_warning: holdWarning } : {}),
    });
  } catch (error) {
    if (error instanceof SessionScriptRunError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return jsonError(error);
  }
}
