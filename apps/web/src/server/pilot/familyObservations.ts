/*
 * WHAT THE FAMILY OBSERVED AT HOME, FOR STAFF (F-073; #1542's track).
 *
 * A guardian records an observation about their child (PH-04,
 * /api/pilot/parent/observations): a category, an optional 1-10 rating and
 * notes, stored as a pilot.coach_observations row of note_type
 * 'parent_observation' whose note_text carries all three
 * (src/shared/parentObservations.ts). Until this read, no staff screen drew
 * them.
 *
 * What staff get: the observations for one athlete, newest first, each parsed
 * back into category, rating and notes, with when it was written. Not who: no
 * account id and no name. The screen says "a guardian", as the coach's barrier
 * inbox does for a guardian's barrier report (F-073 Q-A default A).
 *
 * No join onto pilot.accounts, on purpose: the parent-authored purge keeps
 * these rows and sets their author to NULL (D-9), and an inner join on the
 * author would silently drop exactly the observations whose guardian has gone.
 *
 * The athlete gate is the route's (assertActorCanAccessAthlete); this read
 * scopes by organization and athlete in the query.
 */
import { query } from './db';
import { parseObservationText, type ParentObservationItem } from '@/src/shared/parentObservations';

export async function listFamilyObservationsForStaff(
  organizationId: string,
  athleteId: string,
): Promise<ParentObservationItem[]> {
  const rows = await query<{ note_id: string; note_text: string; created_at: string }>(
    `select co.note_id::text as note_id,
            co.note_text,
            to_char(co.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
       from pilot.coach_observations co
      where co.organization_id = $1
        and co.athlete_id = $2
        and co.note_type = 'parent_observation'
      order by co.created_at desc, co.note_id`,
    [organizationId, athleteId],
  );
  return rows.map((row) => ({
    note_id: row.note_id,
    created_at: row.created_at,
    ...parseObservationText(row.note_text),
  }));
}
