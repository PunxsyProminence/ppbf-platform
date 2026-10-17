import type { ActorIdentity } from './access';
import { writePilotAuditEvent } from './audit';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query, withTransaction } from './db';
import { ForbiddenError } from './errors';
import { SessionScriptRunError } from './sessionScriptRuns';
import { lockLiveAthlete, lockStaffMembership, staffNoteRoleInOrganization, staffRoleReachingAthlete } from './sessionStaffNotes';

// WHO WAS IN A SESSION (audit finding F-067).
//
// A run (pilot.session_script_runs) named no athlete: it carried a COUNT the
// coach typed at End Session. So a coach running a session, plain or scripted,
// could not record who was there. This module is that record:
// pilot.session_run_athletes, one row per run and athlete, owned by
// infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql. Nothing
// here issues DDL.
//
// SESSION DETAIL, NOT ATTENDANCE. The attendance precedence ruling (CT-13,
// docs/current/ATTENDANCE_PRECEDENCE.md) names what counts as attendance, and a
// mark here is not one of them: pilot.attendance_reconciled does not read this
// table and nothing here feeds a report. Nothing is written to the athlete's
// own tables either: not pilot.sessions, not pilot.athlete_check_ins. An
// athlete's own check-in is never touched.
//
// WHO WRITES: THE COACH DELIVERING THE RUN, WHILE IT IS LIVE, the rule every
// other write to a run holds (sessionScriptRuns.ts requireOwnLiveRun,
// roundTimers.ts lockOwnLiveRun), with the same answers: another coach's run
// reads exactly like a missing one, and a settled run is not changed. The coach
// must also be staff in this organization and reach the athlete
// (staffRoleReachingAthlete: active membership role here, then
// assertActorCanAccessAthlete; a coach's reach is the whole gym,
// OD-2026-10-11-007).
//
// WHO READS: staff of the gym, and ONLY the athletes the caller may reach. A
// delivered session used to be a gym-level record that named no athlete
// (sessionBlockLinks.ts); it now names minors. So listPresentAthletes takes the
// caller's permitted athlete ids (the gym's live athletes) as a REQUIRED argument and filters in SQL, as
// listBlocksForRun does: there is no "null means everyone". Athletes, parents,
// the board and the platform owner have no read of this at all
// (OD-2026-10-10-003 items 3 and 4); no route for them imports this module.
//
// A MARK TAKEN BACK KEEPS ITS ROW (removed_at, removed_by_account_id); marking
// the athlete again clears them. The row holds the mark's CURRENT state, so
// every mark, take-back and re-mark writes an audit event, which is where the
// history lives. shadow_mirror is false for the reason sessionStaffNotes.ts
// gives: the mirrored shadow event would be readable by the athlete and their
// guardians, tied to them by details.athlete_id, and this is staff only.

const NOT_PERMITTED = 'This account may not record this athlete as present.';

export type RunAthleteOutcome = 'marked' | 'unmarked' | 'unchanged';

interface RunOwnership {
  delivered_by_account_id: string;
  run_state: string | null;
}

/**
 * Mark an athlete present in the actor's own live run, or take the mark back.
 * Asking for the state the mark already has writes nothing.
 */
export async function setRunAthletePresent(input: {
  actor: ActorIdentity;
  runId: string;
  athleteId: string;
  present: boolean;
}): Promise<{ outcome: RunAthleteOutcome }> {
  const { actor, runId, athleteId } = input;
  // One refusal for "not staff here", "another gym's athlete", "a deleted
  // athlete" and "no such athlete": the answer says nothing about the id.
  if (!(await staffRoleReachingAthlete(actor, athleteId))) {
    throw new ForbiddenError(NOT_PERMITTED, 'SESSION_RUN_ATHLETE_NOT_PERMITTED');
  }

  return withTransaction(async (client) => {
    // The marker must still be staff here now, not only when the check above ran: an admin
    // ending the membership, or deactivating the account, in between gets no mark. Lock order,
    // one way only: membership and account, run row, athlete row, mark row (lockStaffMembership).
    const role = await lockStaffMembership(client, actor);
    if (!role) {
      throw new ForbiddenError(NOT_PERMITTED, 'SESSION_RUN_ATHLETE_NOT_PERMITTED');
    }
    // Read under a row lock, so a finish cannot land between this check and the write.
    const run = await client.query<RunOwnership>(
      `select delivered_by_account_id, run_state
         from pilot.session_script_runs
        where organization_id = $1 and run_id = $2
          for update`,
      [actor.organizationId, runId],
    );
    const owned = run.rows[0];
    // The same codes as requireOwnLiveRun: another coach's run reads exactly like a missing one.
    if (!owned || owned.delivered_by_account_id !== actor.accountId) {
      throw new SessionScriptRunError('SESSION_RUN_NOT_FOUND', 404);
    }
    if (owned.run_state !== 'in_progress') {
      throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
    }
    // The athlete must still be live now, not only when the reach check above ran: one
    // soft-deleted in between gets no mark (the same single refusal).
    if (!(await lockLiveAthlete(client, actor.organizationId, athleteId))) {
      throw new ForbiddenError(NOT_PERMITTED, 'SESSION_RUN_ATHLETE_NOT_PERMITTED');
    }

    let outcome: RunAthleteOutcome;
    let remarked = false;
    if (input.present) {
      // A first mark inserts. A mark that was taken back is cleared and re-stamped. A standing
      // mark matches neither arm (the conflict's WHERE is false), returns no row, and is left alone.
      const written = await client.query<{ inserted: boolean }>(
        `insert into pilot.session_run_athletes as m
           (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id, run_id, athlete_id) do update
           set removed_at = null,
               removed_by_account_id = null,
               marked_by_account_id = excluded.marked_by_account_id,
               marked_by_role = excluded.marked_by_role,
               marked_at = clock_timestamp()
           where m.removed_at is not null
         returning (xmax = 0) as inserted`,
        [actor.organizationId, runId, athleteId, actor.accountId, role],
      );
      outcome = written.rows[0] ? 'marked' : 'unchanged';
      remarked = written.rows[0] ? !written.rows[0].inserted : false;
    } else {
      const removed = await client.query(
        `update pilot.session_run_athletes
            set removed_at = clock_timestamp(), removed_by_account_id = $4
          where organization_id = $1 and run_id = $2 and athlete_id = $3 and removed_at is null`,
        [actor.organizationId, runId, athleteId, actor.accountId],
      );
      outcome = removed.rowCount === 1 ? 'unmarked' : 'unchanged';
    }

    if (outcome !== 'unchanged') {
      await writePilotAuditEvent(
        {
          event_type: outcome === 'marked' && !remarked ? 'create' : 'update',
          actor_account_id: actor.accountId,
          actor_role: role,
          organization_id: actor.organizationId,
          entity_type: 'session_run_athlete',
          entity_id: `${runId}:${athleteId}`,
          details: { run_id: runId, athlete_id: athleteId, present: input.present, ...(remarked ? { remarked: true } : {}) },
          shadow_mirror: false,
        },
        client,
      );
    }
    return { outcome };
  });
}

export interface PresentAthlete {
  run_id: string;
  athlete_id: string;
  full_name: string;
  marked_at: string;
}

/**
 * The athletes whose mark STANDS in each of these runs, by name, for the
 * athletes the caller may reach.
 *
 * `permittedAthleteIds` is required and is the filter: the caller passes the
 * athlete ids it has established this reader may see (the gym's live athletes, for a coach and an
 * organization admin's gym), and an athlete outside that list is not returned
 * whatever the run says. An empty list returns nothing. The organization is in
 * the WHERE on both tables, so another gym's run of the same id adds no row.
 */
export async function listPresentAthletes(
  organizationId: string,
  runIds: readonly string[],
  permittedAthleteIds: readonly string[],
): Promise<PresentAthlete[]> {
  if (runIds.length === 0 || permittedAthleteIds.length === 0) return [];
  return query<PresentAthlete>(
    `select m.run_id, m.athlete_id, a.full_name, m.marked_at
       from pilot.session_run_athletes m
       join pilot.athletes a
         on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id
        and a.deleted_at is null -- a live athlete at the moment of this read, not only when the ids were computed
      where m.organization_id = $1
        and m.run_id = any($2::text[])
        and m.athlete_id = any($3::text[])
        and m.removed_at is null
      order by m.run_id, a.full_name, m.athlete_id`,
    [organizationId, [...runIds], [...permittedAthleteIds]],
  );
}

/**
 * The athlete ids a staff reader may see presence for: every live athlete of
 * the reader's own organization, for a coach and for an organization admin
 * alike. Every other role gets none, so a route that forgot its role gate
 * would still return nothing. The ids are never taken from a request.
 *
 * STAFF HERE means what it means for a mark and for a note: an ACTIVE
 * membership in this organization in a staff role (staffNoteRoleInOrganization),
 * not the role the session carries. A coach whose membership was ended reads
 * nobody, exactly as they can mark nobody.
 *
 * A COACH'S REACH IS THE WHOLE GYM (OD-2026-10-11-007): assertCoachReachesAthlete
 * admits any athlete of the coach's organization who is not deleted, and that is
 * the gate a mark is written through. So the read uses the same set, which is
 * organizationActionableRoster's (this organization, deleted_at is null) -- NOT
 * coachAuthorizedRoster, which is "my athletes" (coach of record plus live
 * coverage) and would hide from a coach the athletes that same coach had just
 * marked present.
 */
export async function staffPermittedAthleteIds(actor: ActorIdentity): Promise<string[]> {
  return (await staffPermittedAthletes(actor)).map((athlete) => athlete.athlete_id);
}

/** An athlete a staff reader may mark or see, as a picker shows them: id and name, nothing else. */
export interface PermittedAthlete {
  athlete_id: string;
  full_name: string;
}

/**
 * The same set as staffPermittedAthleteIds, with names, in name order: what the live screen offers
 * a coach to mark present (F-067). It is the set the mark gate admits, so the picker neither hides
 * an athlete the coach may mark nor offers one the server would refuse (OD-2026-10-11-007). Id and
 * name only: nothing else from the athlete row leaves this function.
 */
export async function staffPermittedAthletes(actor: ActorIdentity): Promise<PermittedAthlete[]> {
  if (!(await staffNoteRoleInOrganization(actor))) {
    return [];
  }
  return (await organizationActionableRoster(actor.organizationId))
    .map(({ athlete_id, full_name }) => ({ athlete_id, full_name }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.athlete_id.localeCompare(b.athlete_id));
}
