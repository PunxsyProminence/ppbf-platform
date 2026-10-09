import { NextResponse, type NextRequest } from 'next/server';

import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import {
  CAPACITY_NOTE_MAX,
  CAPACITY_NOTE_ROLES,
  type AthleteCapacityNoteRow,
  addCapacityNote,
  readCapacityNotes,
  withdrawCapacityNote,
} from '@/src/server/pilot/athleteCapacityNotes';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A coach's physical capacity notes for one athlete (module 013 slice,
 * OD-2026-10-08-002).
 *
 *   GET    ?athlete_id=            this athlete's live notes, newest first (newest 100;
 *                                  older_notes says whether older live notes exist)
 *   POST   { athlete_id, note }    adds one note in the coach's words
 *   DELETE ?athlete_id=&note_id=   withdraws one of the caller's OWN notes
 *
 * Plain text in, plain text out: the route stores what a coach typed and
 * reads it back. It computes nothing from a note (see athleteCapacityNotes.ts).
 * Each row answers `own` (written by this session's account) and the author's
 * display NAME; the author's account id is not in the response.
 *
 * Authorization lives in the module (membership role here + the athlete
 * chokepoint); requireRole is the cheap first refusal for roles that can
 * never pass it.
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

function present(row: AthleteCapacityNoteRow, accountId: string) {
  return {
    note_id: row.note_id,
    athlete_id: row.athlete_id,
    note: row.note,
    author_name: row.author_name,
    author_role: row.author_role,
    created_at: row.created_at,
    own: row.author_account_id === accountId,
  };
}

function athleteIdFrom(request: NextRequest): string {
  const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
  if (!athleteId) throw new ValidationError('Missing athlete_id');
  return athleteId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CAPACITY_NOTE_ROLES]);
    const athleteId = athleteIdFrom(request);
    const { notes, olderNotes } = await readCapacityNotes(actorOf(principal), athleteId);
    return NextResponse.json(
      {
        ok: true,
        note_max: CAPACITY_NOTE_MAX,
        notes: notes.map((row) => present(row, principal.accountId)),
        older_notes: olderNotes,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CAPACITY_NOTE_ROLES]);

    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object');
    }
    const body = parsed as Record<string, unknown>;
    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');
    if (typeof body.note !== 'string') throw new ValidationError('note must be text');

    const row = await addCapacityNote({ actor: actorOf(principal), athleteId, note: body.note });
    return NextResponse.json({ ok: true, note: present(row, principal.accountId) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CAPACITY_NOTE_ROLES]);
    const athleteId = athleteIdFrom(request);
    const noteId = request.nextUrl.searchParams.get('note_id')?.trim() ?? '';
    // The column is a uuid; a hand-crafted id would otherwise be a database
    // error (22P02) answered as a 500.
    if (!UUID_SHAPE.test(noteId)) throw new ValidationError('note_id must be a note id');

    await withdrawCapacityNote({ actor: actorOf(principal), athleteId, noteId });
    return NextResponse.json({ ok: true, note_id: noteId });
  } catch (error) {
    return jsonError(error);
  }
}
