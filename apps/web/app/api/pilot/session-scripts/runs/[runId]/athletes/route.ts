import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  listPresentAthletes,
  setRunAthletePresent,
  staffPermittedAthletes,
} from '@/src/server/pilot/sessionRunAthletes';
import { SessionScriptRunError } from '@/src/server/pilot/sessionScriptRuns';

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
// A mark is session detail, not attendance: nothing here writes or feeds an attendance record
// (CT-13, docs/current/ATTENDANCE_PRECEDENCE.md).
const RUN_ROLES = ['coach', 'admin', 'organization_admin'] as const;

const NUL = '\u0000';

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

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
    const extras = Object.keys(record).filter((key) => key !== 'athlete_id' && key !== 'present');
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

    const { outcome } = await setRunAthletePresent({
      actor: {
        accountId: principal.accountId,
        role: principal.role,
        organizationId: principal.organizationId,
        athleteId: principal.athleteId,
      },
      runId,
      athleteId,
      present: record.present,
    });
    return NextResponse.json({ outcome, athlete_id: athleteId, present: record.present });
  } catch (error) {
    if (error instanceof SessionScriptRunError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return jsonError(error);
  }
}
