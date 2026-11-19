import { NextResponse, type NextRequest } from 'next/server';

import { type ActorIdentity, athleteIdsForCoach, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { organizationActionableRoster } from '@/src/server/pilot/coachAthleteRoster';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  addRestMark,
  clearRestMark,
  listRestMarks,
  loadWeekWindows,
  REST_MARK_CLEAR_FIELDS,
  REST_MARK_CREATE_FIELDS,
  REST_MARK_KINDS,
  REST_MARK_ROLES,
  type RestMarkRow,
  restMarkReadWindow,
  restMarkUnknownFieldsError,
} from '@/src/server/pilot/restMarks';
import { gymDayIso } from '@/src/lib/gymTime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rest and away marks (lane R6-b1, OD-2026-11-17-004: "a recorded rest or
 * away mark (no health reason asked for minors)").
 *
 *   GET                                           the 5 load weeks (Rule 6's 7-day buckets,
 *                                                 newest first) and the live marks from the
 *                                                 oldest of them to 34 days ahead (a planned
 *                                                 holiday shows and can be undone), for the
 *                                                 athletes this caller's analytics shows
 *   POST   { athlete_id, kind, first_day, last_day }   records one mark (one tap = one week)
 *   DELETE ?athlete_id=&mark_id=                  undoes one mark (the row is kept)
 *
 * NO REASON. The body and the query take exactly the fields above. Any other
 * field -- a reason, a note, anything -- is refused with 400 rather than
 * dropped, so no screen can start collecting one without failing.
 *
 * WHO. requireRole(REST_MARK_ROLES) is the cheap first refusal; the module
 * decides again by active membership role here plus assertActorCanAccessAthlete.
 * The GET roster is the same one /api/pilot/analytics/performance computes over
 * (a coach's own athletes and live coverage; an admin's whole live roster), so
 * the strip never shows marks for an athlete the card does not show.
 * Marker account ids never leave the server.
 */

function actorOf(principal: ActorIdentity): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

function present(row: RestMarkRow) {
  return {
    mark_id: row.mark_id,
    athlete_id: row.athlete_id,
    kind: row.kind,
    first_day: row.first_day,
    last_day: row.last_day,
  };
}

async function rosterIds(principal: ActorIdentity): Promise<string[]> {
  if (principal.role === 'coach') return athleteIdsForCoach(principal.organizationId, principal.accountId);
  if (isOrganizationAdminRole(principal.role) || principal.role === 'admin') {
    return (await organizationActionableRoster(principal.organizationId)).map((athlete) => athlete.athlete_id);
  }
  return [];
}

function requireToday(): string {
  const today = gymDayIso();
  if (!today) throw new Error('Unable to resolve the gym date.');
  return today;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REST_MARK_ROLES]);
    const extra = restMarkUnknownFieldsError(Object.fromEntries(request.nextUrl.searchParams), []);
    if (extra) throw new ValidationError(extra, 'REST_MARK_UNKNOWN_FIELD');

    const today = requireToday();
    const weeks = loadWeekWindows(today);
    const ids = await rosterIds(principal);
    const readWindow = restMarkReadWindow(today);
    const marks = await listRestMarks(actorOf(principal), ids, readWindow.from_day, readWindow.to_day);
    return NextResponse.json(
      { ok: true, today, kinds: [...REST_MARK_KINDS], weeks, marks: marks.map(present) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REST_MARK_ROLES]);

    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object');
    }
    const body = parsed as Record<string, unknown>;
    const extra = restMarkUnknownFieldsError(body, REST_MARK_CREATE_FIELDS);
    if (extra) throw new ValidationError(extra, 'REST_MARK_UNKNOWN_FIELD');
    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');

    const { mark, created } = await addRestMark({
      actor: actorOf(principal),
      athleteId,
      kind: body.kind,
      firstDay: body.first_day,
      lastDay: body.last_day,
      today: requireToday(),
    });
    return NextResponse.json({ ok: true, created, mark: present(mark) }, { status: created ? 201 : 200 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REST_MARK_ROLES]);
    // An undo carries nothing but its two ids: a body (a reason, say) is refused, not read.
    if ((await request.text().catch(() => '')).trim() !== '') {
      throw new ValidationError('Undo takes no request body; it records no reason.', 'REST_MARK_UNKNOWN_FIELD');
    }
    const params = Object.fromEntries(request.nextUrl.searchParams);
    const extra = restMarkUnknownFieldsError(params, REST_MARK_CLEAR_FIELDS);
    if (extra) throw new ValidationError(extra, 'REST_MARK_UNKNOWN_FIELD');
    const athleteId = params.athlete_id?.trim() ?? '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');
    const markId = params.mark_id?.trim() ?? '';

    await clearRestMark({ actor: actorOf(principal), athleteId, markId });
    return NextResponse.json({ ok: true, mark_id: markId });
  } catch (error) {
    return jsonError(error);
  }
}
