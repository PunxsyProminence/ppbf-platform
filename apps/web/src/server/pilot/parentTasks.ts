import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';

/**
 * DUE-AND-DONE STATE FOR A PARENT-SUPPORT TASK.
 *
 * A task here is not a new kind of thing. It is a pilot.coach_observations row
 * with note_type = 'parent_message' -- a coach telling a guardian something --
 * that has acquired a due date. "Bring gloves Thursday" and "the medical form
 * is still outstanding" are already sayable; what was missing was any record
 * of whether they happened.
 *
 * The state lives in pilot.parent_task_state, keyed to the note. The message
 * bus gains nothing: see that migration's header for why two columns on
 * pilot.coach_observations would have been the wrong answer, and why reusing
 * the existing note_type rather than adding one removes the failure mode
 * where a new type is missed out of a reader's allow-list.
 *
 * NOT VERIFIED WORK, AND THERE IS NOWHERE TO VERIFY IT. The athlete assignment
 * tables record a completion and then a coach's verification of it
 * (assignment_completions.verification_status). That is right for technical
 * work an athlete performed and a coach watched. It is wrong for a guardian
 * bringing kit, and a coach being asked to countersign that a family did a
 * household errand is the masquerade this module exists to avoid. There is no
 * verification column and no code path that would write one.
 */

/** Who may put a due date on a message, or take one off.
 *
 *  The same people who can write the message in the first place. A guardian
 *  cannot set their own task here -- not because a guardian's own reminders
 *  are illegitimate, but because they would be a different feature with a
 *  different author and a different audience, and quietly admitting them
 *  through this door would make "who asked for this" unanswerable. */
export function canSetParentTask(role: PilotRole): boolean {
  return isOrganizationAdminRole(role) || role === 'coach';
}

export interface ParentTaskState {
  noteId: string;
  dueDate: string | null;
  completedAt: string | null;
  completedByAccountId: string | null;
}

interface ParentTaskRow {
  note_id: string;
  due_date: string | null;
  completed_at: string | null;
  completed_by_account_id: string | null;
}

function toState(row: ParentTaskRow): ParentTaskState {
  return {
    noteId: row.note_id,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    completedByAccountId: row.completed_by_account_id,
  };
}

/**
 * Task state for a set of notes, as a map from note_id.
 *
 * Takes the note ids the caller has ALREADY been authorised to read rather
 * than doing its own athlete lookup. The guardian scoping belongs to whoever
 * assembled that list -- listParentMessages via guardianAthleteIds -- and a
 * second, differently-shaped authorisation here would be a second thing to
 * keep correct. Given no ids it asks the database nothing.
 */
export async function parentTaskStateForNotes(
  organizationId: string,
  noteIds: readonly string[],
): Promise<Map<string, ParentTaskState>> {
  if (noteIds.length === 0) return new Map();

  const rows = await query<ParentTaskRow>(
    `select note_id::text as note_id, due_date::text as due_date,
            completed_at::text as completed_at, completed_by_account_id
       from pilot.parent_task_state
      where organization_id = $1 and note_id = any($2::uuid[])`,
    [organizationId, noteIds],
  );

  return new Map(rows.map((row) => [row.note_id, toState(row)]));
}

/**
 * Put a due date on a parent message, or move one.
 *
 * The note must already be a 'parent_message' in this organization. That is
 * checked here rather than left to the foreign key, because the key only
 * proves the note exists: a coach observation or a guardian's barrier report
 * would satisfy it just as well, and turning one of those into a "task" would
 * put a due date on a note whose audience is not the guardian at all.
 */
export async function setParentTaskDueDate(params: {
  organizationId: string;
  noteId: string;
  dueDate: string | null;
  actorAccountId: string;
  actorRole: PilotRole;
}): Promise<ParentTaskState> {
  if (!canSetParentTask(params.actorRole)) {
    throw new Error('Forbidden: role may not set a parent task');
  }

  const note = await queryOne<{ note_type: string }>(
    `select note_type from pilot.coach_observations
      where organization_id = $1 and note_id = $2::uuid`,
    [params.organizationId, params.noteId],
  );

  if (!note) {
    throw new Error('Not found: no such note in this organization');
  }
  if (note.note_type !== 'parent_message') {
    throw new Error('Forbidden: only a parent message can carry a task');
  }

  const row = await queryOne<ParentTaskRow>(
    `insert into pilot.parent_task_state
       (organization_id, note_id, due_date, created_by_account_id)
     values ($1, $2::uuid, $3::date, $4)
     on conflict (organization_id, note_id) do update set
       due_date = excluded.due_date,
       updated_at = now()
     returning note_id::text as note_id, due_date::text as due_date,
               completed_at::text as completed_at, completed_by_account_id`,
    [params.organizationId, params.noteId, params.dueDate, params.actorAccountId],
  );

  if (!row) {
    throw new Error('Not found: no such note in this organization');
  }

  return toState(row);
}

/**
 * Tick a task off, or put it back.
 *
 * THE CALLER AUTHORISES THE ATHLETE, NOT THIS FUNCTION. It takes the athlete
 * ids the guardian is already known to hold and refuses any note outside
 * them, so the parent route's existing guardianAthleteIds scoping is the
 * single place that decides which children this account may act for.
 *
 * Both directions are allowed and neither is privileged. A guardian who ticked
 * the wrong row must be able to untick it; a task that was closed and then
 * turns out not to have happened must be reopenable. Nothing downstream
 * depends on a completion being permanent, because nothing verifies it.
 */
export async function setParentTaskCompletion(params: {
  organizationId: string;
  noteId: string;
  completed: boolean;
  actorAccountId: string;
  athleteIdsInScope: readonly string[];
}): Promise<ParentTaskState> {
  if (params.athleteIdsInScope.length === 0) {
    throw new Error('Forbidden: no athletes in scope for this account');
  }

  const row = await queryOne<ParentTaskRow>(
    `update pilot.parent_task_state t
        set completed_at = case when $3 then now() else null end,
            completed_by_account_id = case when $3 then $4 else null end,
            updated_at = now()
       from pilot.coach_observations co
      where co.organization_id = t.organization_id
        and co.note_id = t.note_id
        and t.organization_id = $1
        and t.note_id = $2::uuid
        and co.athlete_id = any($5::text[])
     returning t.note_id::text as note_id, t.due_date::text as due_date,
               t.completed_at::text as completed_at, t.completed_by_account_id`,
    [
      params.organizationId,
      params.noteId,
      params.completed,
      params.actorAccountId,
      params.athleteIdsInScope,
    ],
  );

  /* One error for "no such task" and for "not your child". A distinct
     not-found would confirm that a task exists on a note this guardian may
     not read, which is a fact about another family. */
  if (!row) {
    throw new Error('Not found: no such task for an athlete in scope');
  }

  return toState(row);
}
