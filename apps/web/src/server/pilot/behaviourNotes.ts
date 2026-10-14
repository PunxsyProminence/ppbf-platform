import { query } from './db';

/* BEHAVIOUR NOTES A COACH SAVED, READ BACK FOR STAFF (F-070).
 *
 * A coach's "Behavior & Habit Note" on the Decision Loop is saved through
 * intake/domain-upsert as a pilot.coach_observations row with
 * note_type = 'behavior_standard' (app/coach/decision-loop/page.tsx). Nothing
 * listed them afterwards, and /coach/behavior-standards said there was no
 * behaviour log. This is the read.
 *
 * WHO READS IT (OD-2026-10-10-003 items 3 and 4): coaches and the
 * organization admin of that gym only. A coach's note is staff only -- no
 * athlete or parent view. The athlete and guardian readers already filter this
 * table to their own closed note-type lists (intake.ts
 * coachObservationNoteTypesForReader, passbook.ts), which do not name
 * 'behavior_standard'; nothing here widens them, and the route that calls this
 * admits only coach, organization_admin and admin.
 */
export const BEHAVIOUR_NOTE_TYPE = 'behavior_standard';

export interface BehaviourNoteRow {
  note_id: string;
  athlete_id: string;
  athlete_name: string | null;
  note_text: string;
  author_role: string | null;
  created_at: string;
}

export const BEHAVIOUR_NOTES_PAGE = 100;

/** Notes in one gym, newest first. Deleted athletes' notes are not listed. */
export async function listBehaviourNotes(
  organizationId: string,
  options: { athleteId?: string; limit?: number } = {},
): Promise<BehaviourNoteRow[]> {
  const limit = Math.min(Math.max(options.limit ?? BEHAVIOUR_NOTES_PAGE, 1), BEHAVIOUR_NOTES_PAGE);
  return query<BehaviourNoteRow>(
    `select co.note_id::text as note_id,
            co.athlete_id,
            a.full_name as athlete_name,
            co.note_text,
            co.author_role,
            to_char(co.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from pilot.coach_observations co
       join pilot.athletes a
         on a.organization_id = co.organization_id
        and a.athlete_id = co.athlete_id
        and a.deleted_at is null
      where co.organization_id = $1
        and co.note_type = $2
        and ($3::text is null or co.athlete_id = $3)
      order by co.created_at desc
      limit $4`,
    [organizationId, BEHAVIOUR_NOTE_TYPE, options.athleteId ?? null, limit],
  );
}
