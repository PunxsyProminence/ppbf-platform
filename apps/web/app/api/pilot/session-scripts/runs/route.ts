import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import { listPresentAthletes, staffPermittedAthleteIds } from '@/src/server/pilot/sessionRunAthletes';
import {
  SESSION_CLASS_MESSAGES,
  SessionRunClassError,
  describeRunClass,
  listTieableClasses,
} from '@/src/server/pilot/sessionRunClass';
import {
  SessionScriptRunError,
  getLiveRunForCoach,
  listSettledRunsForOrganization,
  listSettledRunsForScript,
  startSessionScriptRun,
} from '@/src/server/pilot/sessionScriptRuns';

export const runtime = 'nodejs';

// Delivering a session script. The sibling route (/api/pilot/session-scripts) is the read-only
// browse over the PLAN and any authenticated role may use it; this is the record of a session
// being RUN, which is coach work and carries who was on the floor.
//
// GET answers "do I have a session in progress" -- the whole point of the run row existing. A
// coach whose phone locked or whose tab reloaded calls this and gets their session back, clock
// intact, because the server computed the elapsed time rather than the tab counting it.
//
// Returns { run: null } rather than 404 when there is no live session: "you have nothing running"
// is a successful answer to that question, not a missing resource.
// With ?script_id= it instead answers "what has been delivered from this plan": the settled
// (completed/abandoned/legacy) runs, via the module's own history read, which already excludes
// live runs -- a session still on the floor is not yet a record of what happened. "This plan" is
// every version of it (the read follows the script's lineage), because the browse list shows only
// the newest version and older versions' deliveries would otherwise be unreachable. Same role gate
// as the live lookup: both response shapes are delivery records and carry who was on the floor.
// Mirrors the sibling browse route's convention of one GET switching on script_id.
//
// With ?finished=true it answers "what sessions has this gym finished": the settled runs, plain
// and scripted, newest first, each with the coach's end notes, who delivered it by display name,
// and who was marked present (audit finding F-067: a plain session has no plan, so the by-plan
// history above could never show it). Present athletes are only those the caller may reach,
// the live athletes of the caller's own gym, filtered in SQL (sessionRunAthletes.ts). Same role
// gate: end notes and presence are staff records with no athlete or parent view
// (OD-2026-10-10-003 items 3 and 4).
//
// With ?classes=today it answers "which classes can I tie a session to now" (D4,
// OD-2026-10-21-002): today's classes, by the gym's day, that the caller runs (an organization
// admin: all), not cancelled, each saying whether another live session already holds it. A live
// run tied to a class also carries `class`: its title, times and status, and how many signed-up
// athletes have no mark yet (the End Session no-shows offer, OD-2026-10-21-004 ruling 3).
//
// platform_owner is refused on every verb here and on runs/[runId]: running a session is gym
// work, done from the gym's own accounts (OD-2026-10-08-003 R2 and PLAN-3).
const RUN_ROLES = ['coach', 'admin', 'organization_admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RUN_ROLES]);

    const scriptId = request.nextUrl.searchParams.get('script_id')?.trim();
    if (scriptId) {
      const runs = await listSettledRunsForScript(principal.organizationId, scriptId);
      return NextResponse.json({ runs });
    }

    if (request.nextUrl.searchParams.get('finished') === 'true') {
      const settled = await listSettledRunsForOrganization(principal.organizationId);
      const permitted = await staffPermittedAthleteIds(principal);
      const present = await listPresentAthletes(principal.organizationId, settled.map((run) => run.run_id), permitted);
      const names = new Map<string, string>();
      for (const accountId of new Set(settled.map((run) => run.delivered_by_account_id))) {
        names.set(accountId, await getCoachDisplayName(principal.organizationId, accountId));
      }
      // Named fields, not the row: who delivered a session is answered by display name and
      // "was it me", so the account id (which can be an email address) is not sent.
      const runs = settled.map((run) => ({
        run_id: run.run_id,
        script_id: run.script_id,
        script_version: run.script_version,
        script_name: run.script_name,
        run_state: run.run_state,
        delivered_on: run.delivered_on,
        started_at: run.started_at,
        ended_at: run.ended_at,
        athletes_present: run.athletes_present,
        blocks_completed: run.blocks_completed,
        deviation_note: run.deviation_note,
        what_worked: run.what_worked,
        what_did_not: run.what_did_not,
        delivered_by_name: names.get(run.delivered_by_account_id) ?? 'A coach',
        delivered_by_me: run.delivered_by_account_id === principal.accountId,
        present: present
          .filter((athlete) => athlete.run_id === run.run_id)
          .map(({ athlete_id, full_name }) => ({ athlete_id, full_name })),
      }));
      return NextResponse.json({ runs }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (request.nextUrl.searchParams.get('classes') === 'today') {
      return NextResponse.json({ classes: await listTieableClasses(principal) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const run = await getLiveRunForCoach(principal.organizationId, principal.accountId);
    const tied = run?.class_id ? await describeRunClass(principal, run.class_id) : null;
    return NextResponse.json(tied ? { run, class: tied } : { run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

// Every start field is optional: a start without script_id is a plain session (Jason 2026-10-12,
// issue #1523); a start without class_id is tied to no class (open gym).
const START_OPTIONAL_FIELDS = ['script_id', 'activity_id', 'athletes_present', 'delivered_on', 'class_id'] as const;

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

// Plain wording for refusals a coach can act on without knowing the code. `error` stays the code
// (the page and the tests switch on it); `message` is what a person reads. Only codes whose remedy
// is not obvious from the code are worded here.
const START_REFUSAL_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    'SESSION_SCRIPT_SUPERSEDED',
    'This plan has been replaced by a newer version, so no session was started. Reload the list and start the current version.',
  ],
  ...SESSION_CLASS_MESSAGES,
]);

// POST starts a run. The body is deliberately narrow: no run_state, no started_at, no elapsed
// time. Those are the server's to set, and accepting them from a client is how a coach's clock
// would become whatever their device believed.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RUN_ROLES]);

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('INVALID_BODY');
    }
    const record = body as Record<string, unknown>;

    const extras = Object.keys(record).filter(
      (key) =>
        !(START_OPTIONAL_FIELDS as readonly string[]).includes(key),
    );
    if (extras.length > 0) {
      return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
    }

    // Absent or null: a plain session. Present: a script to run, which must name one.
    if (
      record.script_id !== undefined
      && record.script_id !== null
      && (typeof record.script_id !== 'string' || record.script_id.trim() === '')
    ) {
      return badRequest('script_id');
    }

    let athletesPresent: number | null = null;
    if (record.athletes_present !== undefined && record.athletes_present !== null) {
      if (
        typeof record.athletes_present !== 'number'
        || !Number.isInteger(record.athletes_present)
        || record.athletes_present < 0
      ) {
        return badRequest('athletes_present');
      }
      athletesPresent = record.athletes_present;
    }

    if (
      record.activity_id !== undefined
      && record.activity_id !== null
      && typeof record.activity_id !== 'string'
    ) {
      return badRequest('activity_id');
    }

    if (
      record.class_id !== undefined
      && record.class_id !== null
      && (typeof record.class_id !== 'string' || record.class_id.trim() === '')
    ) {
      return badRequest('class_id');
    }

    // A date, not a timestamp: delivered_on is which night this was, and accepting a full
    // timestamp here would invite it to be confused with the start time the server owns.
    //
    // The shape check alone is not enough. '2026-02-31' satisfies the pattern and then fails
    // Postgres's ::date cast inside the writer, which surfaces as a 500 -- so an ordinary bad
    // client date looked like an internal outage instead of a 400 naming the field. Round-tripping
    // through Date and comparing back catches every non-existent day, including February 30th and
    // the 31st of a 30-day month, without hand-coding a calendar.
    if (record.delivered_on !== undefined && record.delivered_on !== null) {
      if (typeof record.delivered_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.delivered_on)) {
        return badRequest('delivered_on');
      }
      const parsed = new Date(`${record.delivered_on}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== record.delivered_on) {
        return badRequest('delivered_on');
      }
    }

    const run = await startSessionScriptRun(principal.organizationId, principal.accountId, {
      scriptId: typeof record.script_id === 'string' ? record.script_id.trim() : null,
      activityId: (record.activity_id as string | undefined) ?? null,
      athletesPresent,
      deliveredOn: (record.delivered_on as string | undefined) ?? undefined,
      classId: typeof record.class_id === 'string' ? record.class_id.trim() : null,
      actorRole: principal.role,
    });

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionScriptRunError || error instanceof SessionRunClassError) {
      const message = START_REFUSAL_MESSAGES.get(error.message);
      return NextResponse.json(
        message ? { error: error.message, message } : { error: error.message },
        { status: error.status },
      );
    }
    return jsonError(error);
  }
}
