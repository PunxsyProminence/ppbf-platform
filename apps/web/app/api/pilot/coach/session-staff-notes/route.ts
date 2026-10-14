import { NextResponse, type NextRequest } from 'next/server';

import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  STAFF_NOTE_MAX,
  STAFF_NOTE_ROLES,
  type ListedSessionStaffNote,
  createRunStaffNote,
  createSessionStaffNote,
  listRunStaffNotes,
  listSessionStaffNotes,
  removeOwnSessionStaffNote,
  updateOwnSessionStaffNote,
} from '@/src/server/pilot/sessionStaffNotes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Staff notes on one athlete's session (OD-2026-10-06-025 ruling 4: the
 * athlete's own note stays theirs; staff add a separate note in their own
 * name).
 *
 *   GET    ?session_id=&athlete_id=          the live staff notes on that session about
 *                                            that athlete, oldest first (the newest 100)
 *   GET    ?run_id=&athlete_id=              the same, for a note on that athlete in a
 *                                            session RUN (F-067)
 *   POST   { session_id, athlete_id, note }  adds one note of the caller's own
 *   POST   { run_id, athlete_id, note }      adds one on that athlete in a session run; the
 *                                            athlete must be marked present in that run
 *   PATCH  { note_id, note }                 changes the text of one of the caller's OWN notes
 *   DELETE ?note_id=                         removes one of the caller's OWN notes
 *
 * A note is on a session OR on a run: a request naming both, or neither, is
 * refused. PATCH and DELETE find a note by its own id, so they serve both kinds.
 *
 * STAFF ONLY (OD-2026-10-10-003 ruling 3: "no athlete or parent view"). There
 * is no athlete, parent or guardian route over this table and none may be
 * added here.
 *
 * Authorization lives in the module (active membership role here + the athlete
 * chokepoint; the author-scoped UPDATE decides edit and removal); requireRole
 * is the cheap first refusal for roles that can never pass it. The route adds
 * nothing looser and filters nothing out. Each listed row answers `own` and
 * the author's display NAME; an account id is in no response.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(principal: ActorIdentity): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

// Field by field, so a column added to the module's row never reaches a
// response by default.
function present(row: ListedSessionStaffNote) {
  return {
    note_id: row.note_id,
    session_id: row.session_id,
    run_id: row.run_id,
    athlete_id: row.athlete_id,
    note: row.note,
    author_name: row.author_name,
    author_role: row.author_role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    own: row.written_by_me,
  };
}

// Postgres text cannot hold a NUL byte; one in an id or a note would be a
// database error answered as a 500.
const NUL = '\u0000';

function textFrom(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ValidationError(`Missing ${field}`);
  if (text.includes(NUL)) throw new ValidationError(`${field} is not valid`);
  return text;
}

// The column is a uuid; a hand-crafted id would otherwise be a database error
// (22P02) answered as a 500.
/** What the note is on: its session or its run. Exactly one must be named. */
function subjectFrom(sessionId: unknown, runId: unknown): { sessionId: string } | { runId: string } {
  const named = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  if (named(sessionId) === named(runId)) {
    throw new ValidationError('Name the session or the run the note is on: exactly one of session_id and run_id');
  }
  return named(runId) ? { runId: textFrom(runId, 'run_id') } : { sessionId: textFrom(sessionId, 'session_id') };
}

function noteIdFrom(value: unknown): string {
  const noteId = typeof value === 'string' ? value.trim() : '';
  if (!UUID_SHAPE.test(noteId)) throw new ValidationError('note_id must be a note id');
  return noteId;
}

async function bodyOf(request: NextRequest): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.note !== 'string' || body.note.includes(NUL)) throw new ValidationError('note must be text');
  return body;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_NOTE_ROLES]);
    const subject = subjectFrom(request.nextUrl.searchParams.get('session_id'), request.nextUrl.searchParams.get('run_id'));
    const athleteId = textFrom(request.nextUrl.searchParams.get('athlete_id'), 'athlete_id');
    const notes = 'runId' in subject
      ? await listRunStaffNotes(actorOf(principal), subject.runId, athleteId)
      : await listSessionStaffNotes(actorOf(principal), subject.sessionId, athleteId);
    return NextResponse.json(
      { ok: true, note_max: STAFF_NOTE_MAX, notes: notes.map(present) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_NOTE_ROLES]);
    const body = await bodyOf(request);
    const subject = subjectFrom(body.session_id, body.run_id);
    const athleteId = textFrom(body.athlete_id, 'athlete_id');
    const row = 'runId' in subject
      ? await createRunStaffNote({ actor: actorOf(principal), runId: subject.runId, athleteId, note: body.note as string })
      : await createSessionStaffNote({ actor: actorOf(principal), sessionId: subject.sessionId, athleteId, note: body.note as string });
    return NextResponse.json({ ok: true, note_id: row.note_id });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_NOTE_ROLES]);
    const body = await bodyOf(request);
    const noteId = noteIdFrom(body.note_id);
    await updateOwnSessionStaffNote({ actor: actorOf(principal), noteId, note: body.note as string });
    return NextResponse.json({ ok: true, note_id: noteId });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_NOTE_ROLES]);
    const noteId = noteIdFrom(request.nextUrl.searchParams.get('note_id'));
    await removeOwnSessionStaffNote({ actor: actorOf(principal), noteId });
    return NextResponse.json({ ok: true, note_id: noteId });
  } catch (error) {
    return jsonError(error);
  }
}
