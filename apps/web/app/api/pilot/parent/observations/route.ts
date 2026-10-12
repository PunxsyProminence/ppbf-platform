import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, withTransaction } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { createCoachObservation } from '@/src/server/pilot/intake';
import {
  composeObservationText,
  isObservationCategory,
  parseObservationText,
  type ParentObservationItem,
} from '@/src/shared/parentObservations';

export const runtime = 'nodejs';

/**
 * WHAT A GUARDIAN NOTICES AT HOME (WO-PH-04): energy, motivation, sleep and
 * recovery, and how the child is developing, written by the family for the
 * coach.
 *
 * THE SAME RECORD AND THE SAME NARROW DOOR AS THE BARRIER REPORT
 * (/api/pilot/parent/barrier-report): a pilot.coach_observations row written
 * through createCoachObservation, parent-only, after assertActorCanAccessAthlete,
 * with author_role recorded from the session and an audit row. No new table,
 * no migration, and intake/domain-upsert's role gate is not widened.
 *
 * WHO READS IT. A guardian reads, here, the observations THEY wrote about
 * THIS child and nothing else -- not the other guardian's, the same line the
 * barrier report draws for split households (LQ-PH04-1). The athlete never
 * does: their reader set is 'coach_observation' only. Staff MAY read every
 * note type (coachObservationNoteTypesForReader), but NO COACH SCREEN DRAWS
 * THIS TYPE TODAY: the coach barrier inbox and the passbook both use closed
 * lists of note types, and neither names it. So the screen that writes these
 * says they are saved to the child's record, and never that a coach has them.
 * A coach reader is its own order (LQ-PH04-4 on #1483).
 *
 * THE FORMAT IS WORDS. The table has no rating or category column, and adding
 * one is a migration this order does not make. So the server composes the
 * note text from validated fields -- "Energy · 7 out of 10", a blank line,
 * then the notes -- which a coach reads as written, and this route parses
 * back with the one grammar it writes. A row it cannot parse is returned whole
 * as notes, never dropped.
 *
 * No update and no delete: a correction is a new entry, as with barrier
 * reports. No account id leaves this route.
 */

const NOTE_TYPE = 'parent_observation';

interface ObservationRow {
  note_id: string;
  note_text: string;
  created_at: string;
}

function toItem(row: ObservationRow): ParentObservationItem {
  return { note_id: row.note_id, ...parseObservationText(row.note_text), created_at: row.created_at };
}

const SELECT_OWN = `select note_id::text as note_id, note_text, created_at::text as created_at
  from pilot.coach_observations
  where organization_id = $1 and athlete_id = $2 and note_type = $3 and coach_account_id = $4`;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteId = (request.nextUrl.searchParams.get('athlete_id') ?? '').trim();
    if (!athleteId || athleteId.length > 300) {
      throw new Error('Missing athlete_id');
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const rows = await query<ObservationRow>(
      `${SELECT_OWN} order by created_at desc`,
      [principal.organizationId, athleteId, NOTE_TYPE, principal.accountId],
    );
    return NextResponse.json({ ok: true, items: rows.map(toItem) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const parsed: unknown = await request.json().catch(() => null);
    const body = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    const rating = body.rating === undefined || body.rating === null ? null : body.rating;
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (
      !athleteId || athleteId.length > 300
      || !isObservationCategory(body.category)
      || (rating !== null && !(typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 10))
      || !notes || notes.length > 4000
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Observation is invalid: athlete_id, a category (energy, motivation, sleep_recovery, general_development), notes (up to 4000 characters) and, if given, a whole-number rating from 1 to 10 are required.',
        },
        { status: 400 },
      );
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    const category = body.category;
    // The note and its audit row are one write: an entry is never saved
    // without its record of who saved it, and a failure after the note is
    // stored can never be reported to the family as "did not save".
    const noteId = await withTransaction(async (client) => {
      const id = await createCoachObservation({
        organizationId: principal.organizationId,
        athleteId,
        coachAccountId: principal.accountId,
        authorRole: principal.role,
        noteType: NOTE_TYPE,
        noteText: composeObservationText(category, rating as number | null, notes),
      }, client);
      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'parent_observation',
        entity_id: id,
        details: { athlete_id: athleteId, category, rated: rating !== null },
      }, client);
      return id;
    });

    // Read back as stored, so the screen shows the row the database holds,
    // its own timestamp included. The entry is saved whatever happens here:
    // a read-back that fails answers 201 with no item, and the screen
    // re-reads the list rather than calling the save a failure.
    let item = null;
    try {
      const [row] = await query<ObservationRow>(
        `${SELECT_OWN} and note_id = $5::uuid`,
        [principal.organizationId, athleteId, NOTE_TYPE, principal.accountId, noteId],
      );
      item = row ? toItem(row) : null;
    } catch {
      item = null;
    }
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
