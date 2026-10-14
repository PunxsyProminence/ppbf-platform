/*
 * WHAT A COACH WROTE TO THE ATHLETE (#1542, FC-06).
 *
 * A coach or organization admin addresses a note to an athlete through the
 * existing coach-note write (intake/domain-upsert, entity_type 'coach_note')
 * with note_type 'athlete_message' -- the type is the classification, as
 * 'parent_message' is for guardians (FC-06 Q-1 default A; no schema change:
 * note_type is free text and the reader lists in intake.ts are closed).
 *
 * The athlete reads their own, newest first: the words, when, and who it is
 * from by name -- never an account id (OD-2026-10-06-025, "Show coach name,
 * hide ID"). Only staff-written rows count (author_role coach, organization
 * admin or admin): the label alone is not proof of who wrote it. Guardians do
 * not read these (FC-06 Q-2 default A, open with the owner). Nothing here
 * writes, sends or notifies.
 */
import { deriveCoachDisplayName } from '@/src/shared/coachDisplayName';

import { query } from './db';

export interface AthleteCoachMessage {
  note_id: string;
  note_text: string;
  created_at: string;
  from_name: string;
}

export async function listAthleteCoachMessages(
  organizationId: string,
  athleteId: string,
): Promise<AthleteCoachMessage[]> {
  // A LEFT join: a message stays readable if its writer's account is later
  // removed; it then reads as from the gym's coaches.
  const rows = await query<{ note_id: string; note_text: string; created_at: string; login_email: string | null; author_role: string }>(
    `select co.note_id::text as note_id,
            co.note_text,
            to_char(co.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
            a.login_email,
            co.author_role
       from pilot.coach_observations co
       left join pilot.accounts a on a.account_id = co.coach_account_id
      where co.organization_id = $1
        and co.athlete_id = $2
        and co.note_type = 'athlete_message'
        and co.author_role in ('coach', 'organization_admin', 'admin')
      order by co.created_at desc, co.note_id`,
    [organizationId, athleteId],
  );
  return rows.map((row) => ({
    note_id: row.note_id,
    note_text: row.note_text,
    created_at: row.created_at,
    from_name: row.author_role === 'coach' ? deriveCoachDisplayName(row.login_email) : 'Your gym',
  }));
}
