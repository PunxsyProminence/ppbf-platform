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
 * admin or admin): the label alone is not proof of who wrote it. Nothing here
 * writes, sends or notifies.
 *
 * GUARDIANS OF A MINOR GET A COPY (FC-06 Q-2, ruled B by Overwatch 2026-10-15
 * from the owner's 2026-08-16 decision in ATHLETE_WORKSPACE_IA_MOCKUP.md:
 * "for youth, guardians receive a copy of athlete messages"): every guardian
 * linked to an athlete under 18 reads, read-only, what staff wrote to that
 * athlete ("Sent to your athlete", kept apart from parent messages). The
 * scope is guardianAthleteIds on each request, which already leaves out an
 * athlete aged 18 or over (guardian access goes dormant at 18) and a deleted
 * athlete. Two guardians each read them: they are the coach's words, not the
 * other guardian's.
 *
 * Staff of the athlete's gym read the same list (GET
 * /api/pilot/coach/athlete-messages) under the coach's form: what was sent to
 * this athlete, so a coach can see a message landed and the gym has a record
 * of what was written to a child.
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

export interface GuardianCopyOfAthleteMessage extends AthleteCoachMessage {
  athlete_id: string;
}

/**
 * What staff wrote to the athletes in this guardian's scope, newest first.
 * The caller passes guardianAthleteIds(org, account) resolved on this request;
 * an empty scope reads nothing.
 */
export async function listGuardianCopiesOfAthleteMessages(
  organizationId: string,
  athleteIdsInScope: readonly string[],
): Promise<GuardianCopyOfAthleteMessage[]> {
  if (athleteIdsInScope.length === 0) return [];
  const rows = await query<{ note_id: string; athlete_id: string; note_text: string; created_at: string; login_email: string | null; author_role: string }>(
    `select co.note_id::text as note_id,
            co.athlete_id,
            co.note_text,
            to_char(co.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
            a.login_email,
            co.author_role
       from pilot.coach_observations co
       left join pilot.accounts a on a.account_id = co.coach_account_id
      where co.organization_id = $1
        and co.athlete_id = any($2::text[])
        and co.note_type = 'athlete_message'
        and co.author_role in ('coach', 'organization_admin', 'admin')
      order by co.created_at desc, co.note_id`,
    [organizationId, [...athleteIdsInScope]],
  );
  return rows.map((row) => ({
    note_id: row.note_id,
    athlete_id: row.athlete_id,
    note_text: row.note_text,
    created_at: row.created_at,
    from_name: row.author_role === 'coach' ? deriveCoachDisplayName(row.login_email) : 'Your gym',
  }));
}
