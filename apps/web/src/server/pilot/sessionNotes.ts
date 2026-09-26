import { GYM_TIME_ZONE, gymDayIso, type GymTimeInput } from '../../lib/gymTime';
import { isSystemCheckInNote } from '../../shared/sessionNoteSemantics';

import { queryOne } from './db';

// A-FIN-08: the one thing a coach needs off today's session row -- the note
// typed into "Anything your coach should know before you start?" -- in the
// shipped athlete UI, by the athlete, though the column itself cannot prove
// that: /api/pilot/sessions and /sessions/update both accept coach and
// organization_admin, and there is no author column. Nothing downstream may
// name a writer.
// -- and nothing else.
//
// DELIBERATELY NOT /api/pilot/sessions/list. That path returns the whole
// session record behind assertActorCanAccessAthlete, which is the narrower
// coach-of-record-or-coverage rule. Widening it to satisfy one note read
// would have widened RPE, completion state and every other column it carries
// at the same time. This module exists so the wider organization-scoped read
// applies to the note ALONE.
//
// WHAT COMES BACK, AND THE DIFFERENCE BETWEEN THE TWO EMPTIES:
//   null            -- no session was started during the current gym day.
//   { note: null }  -- a session exists, but nobody wrote a human note on it.
//   { note: text }  -- the stored words, exactly as stored.
// The coach screen says different things for those first two, so they must
// not collapse into one another here. "No session started today" and "no note
// written today" are different facts about a child's day.

/** Today's session note for one athlete, or null when there is no session. */
export interface TodaySessionNote {
  /** The human note, or null when the row carries none worth showing. */
  note: string | null;
}

interface SessionNoteRow {
  // `notes text not null` -- infra/azure/pilot_slice_postgres.sql:97, and no
  // later migration changes it. Typed as a plain string to match the schema
  // and pilot.sessions elsewhere, rather than claiming a null the column
  // cannot hold.
  //
  // What the schema does NOT enforce is non-emptiness. That comes from
  // validateSessionPayload's requireString on the write path, and
  // scripts/seed-data.ts inserts straight from CSV without it -- so '' rows
  // are reachable and this read has to handle them.
  notes: string;
}

/**
 * "Today" is the GYM's day in America/New_York, taken from `created_at`.
 *
 * NOT the `date` column. AthleteWorkspace fills that with
 * `new Date().toISOString().slice(0, 10)`, which is UTC -- so from about 8pm
 * at the gym it already reads as tomorrow, and a coach standing on the floor
 * during an evening session would be told there is no session today. The
 * column is left exactly as it is; this read simply does not depend on it.
 *
 * `created_at` is timestamptz and records when the session was actually
 * started, so reducing THAT instant in the gym's zone gives the day the
 * people in the room are living in.
 *
 * THE ZONE IS SINGLE-SOURCED, THE EXPRESSION IS NOT. blockReview.ts:88 holds
 * the same `(column at time zone ...)::date` reduction, but it is private to
 * that module and blockReview.ts is not in this slice's authorized files.
 * Rebuilding the one line here from the SAME exported GYM_TIME_ZONE keeps the
 * zone one value rather than two that happen to agree -- which is the part
 * that would actually rot -- and costs a duplicated expression instead of a
 * refactor that widens the slice. (Confirmed as the intended trade rather
 * than assumed.)
 *
 * The zone is interpolated from that constant and never from a caller's
 * value; athlete and organization are bound parameters.
 */
export async function getTodaySessionNote(
  organizationId: string,
  athleteId: string,
  now?: GymTimeInput,
): Promise<TodaySessionNote | null> {
  const gymDay = gymDayIso(now ?? new Date());
  if (!gymDay) throw new Error('SESSION_NOTE_GYM_DAY_UNRESOLVED');

  // Newest first: an athlete who starts a second session on the same day is
  // telling their coach about the one they are about to do, not the one that
  // finished hours ago.
  const row = await queryOne<SessionNoteRow>(
    `select notes
     from pilot.sessions
     where organization_id = $1
       and athlete_id = $2
       and (created_at at time zone '${GYM_TIME_ZONE}')::date = $3::date
     order by created_at desc
     limit 1`,
    [organizationId, athleteId, gymDay],
  );

  if (!row) return null;

  // THREE THINGS ARE "NO HUMAN NOTE", not one.
  //
  // The two system forms are suppressed HERE, not only on the coach's screen:
  // a placeholder or a historical "Auto check-in readiness GREEN" leaving
  // this function would be one rendering bug away from appearing to a coach
  // as something a child said about themselves. The screen filters them
  // again; this is the gate that does not depend on the screen being right.
  //
  // The third is an EMPTY note, which the column permits. `notes` is not
  // null, but nothing in the schema forbids '' or whitespace -- requireString
  // only guards the app's own write path, and the CSV seeder does not use it.
  // An empty string rendered on a coach's screen is a note that says nothing
  // while looking like one was written.
  const stored = typeof row.notes === 'string' ? row.notes : '';
  if (stored.trim() === '' || isSystemCheckInNote(stored)) return { note: null };

  // Returned exactly as stored rather than trimmed: the spacing and line
  // breaks are the athlete's own.
  return { note: stored };
}
