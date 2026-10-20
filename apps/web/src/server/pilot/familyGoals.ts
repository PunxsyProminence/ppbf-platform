/*
 * FAMILY GOALS (#1593, PH-06): what a family and the gym agree the family will
 * do to support one child. Stored in pilot.family_goals (PH-05), which keeps
 * who wrote each goal, records "done" as a time and never deletes: a goal
 * taken down is retired.
 *
 * Who reads what (OD-2026-10-12-024's principle, the standing rule that a
 * guardian never reads another guardian's notes or ticks, and PH-06 Q-2 A):
 *   - A guardian reads the goals they wrote and the goals the gym's staff
 *     wrote for the child, never the other guardian's.
 *   - A guardian changes only goals they wrote. A staff goal is read-only to
 *     families: if one guardian ticked it, the other would see that tick.
 *   - Only a child linked to this guardian now (not deleted, under 18), on
 *     every request; anything else is the same 404.
 * A goal names who set it as "You" or the staff member's display name; no
 * account id leaves the server (OD-2026-10-06-025).
 *
 * THE STAFF SIDE (PH-06b, "completion state returns to coach"):
 *   - Staff (coach, organization admin, legacy admin: Q-E A) read every live
 *     goal of a child in their own gym, both guardians' and staff's, with its
 *     done state and dates. A guardian's goal names its writer only as
 *     "A guardian"; a staff goal by the staff member's display name.
 *   - Staff change ONLY staff-written goals (PH-06 Q-2 A): a guardian's goal is
 *     the guardian's, so staff never edit, tick, untick or retire it. Any staff
 *     member of the gym may change any staff goal for the child.
 *   - A staff write is made with the caller's own account and session role, so
 *     the database's seat check (an active membership with that role in the
 *     gym, on a live account) judges the real writer.
 * The route gates the athlete with assertActorCanAccessAthlete; a change finds
 * its goal's athlete here and gates it the same way.
 */
import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { query, queryOne } from './db';
import { NotFoundError, ValidationError } from './errors';
import { isGuardianLinkedToAthlete } from './guardianAccess';
import { staffFacingAuthorName } from './parentTasks';
import { coachDisplayNameFor } from '@/src/shared/coachDisplayName';

export const FAMILY_GOAL_TITLE_MAX = 200;
export const FAMILY_GOAL_SUPPORT_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// One sentence for a forged id, another gym's goal, another guardian's goal,
// a staff goal, and a child no longer linked: which it was is not this
// caller's to learn.
const NOT_YOURS = 'Not found: that goal is not one you can change.';
const NOT_YOUR_CHILD = 'Not found: that child is not on your page.';

// The staff roles (Q-E A): the one list every staff check and query is built from.
const STAFF_ROLES = ['coach', 'organization_admin', 'admin'] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

function isStaffRole(role: string): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

export interface FamilyGoalForGuardian {
  goal_id: string;
  title: string;
  support_action: string;
  target_date: string | null;
  state: 'active' | 'completed';
  completed_at: string | null;
  set_by: string;
  mine: boolean;
}

interface GoalRow {
  goal_id: string;
  title: string;
  support_action: string;
  target_date: string | null;
  state: 'active' | 'completed';
  completed_at: string | null;
  created_by_account_id: string | null;
  created_by_role: string;
  login_email: string | null;
  staff_display_name: string | null;
}

const SELECT_GOAL = `
  select g.goal_id::text as goal_id, g.title, g.support_action,
         to_char(g.target_date, 'YYYY-MM-DD') as target_date,
         g.state,
         to_char(g.completed_at at time zone 'UTC', ${ISO_UTC}) as completed_at,
         g.created_by_account_id, g.created_by_role, a.login_email, ap.staff_display_name
    from pilot.family_goals g
    left join pilot.accounts a on a.account_id = g.created_by_account_id
    left join pilot.account_profiles ap
      on ap.organization_id = g.organization_id and ap.account_id = g.created_by_account_id`;

function present(row: GoalRow, accountId: string): FamilyGoalForGuardian {
  const mine = row.created_by_role === 'parent' && row.created_by_account_id === accountId;
  return {
    goal_id: row.goal_id,
    title: row.title,
    support_action: row.support_action,
    target_date: row.target_date,
    state: row.state,
    completed_at: row.completed_at,
    set_by: mine ? 'You' : row.created_by_role === 'coach' ? coachDisplayNameFor(row.staff_display_name, row.login_email) : 'Your gym',
    mine,
  };
}

function cleanText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ValidationError(`Write the ${label} before saving.`);
  if (text.length > max) throw new ValidationError(`The ${label} is at most ${max} characters.`);
  return text;
}

function cleanDay(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  // A real calendar day: Date rolls 2026-02-31 over to March, so the day it
  // lands on must be the day that was written.
  const parsed = typeof value === 'string' && DAY.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  // Year 0000 round-trips through Date but PostgreSQL's date has no year zero
  // (22008), which would surface as a 500 instead of this 400.
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) {
    throw new ValidationError('The target date must be a date (YYYY-MM-DD).');
  }
  return value;
}

/** This guardian's goals and staff goals for one linked child, newest first; retired ones left out. */
export async function listFamilyGoalsForGuardian(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<FamilyGoalForGuardian[]> {
  if (!(await isGuardianLinkedToAthlete(organizationId, accountId, athleteId))) {
    throw new NotFoundError(NOT_YOUR_CHILD);
  }
  const rows = await query<GoalRow>(
    `${SELECT_GOAL}
      where g.organization_id = $1 and g.athlete_id = $2 and g.retired_at is null
        and ((g.created_by_role = 'parent' and g.created_by_account_id = $3)
             or g.created_by_role = any($4::text[]))
      order by g.created_at desc, g.goal_id`,
    [organizationId, athleteId, accountId, [...STAFF_ROLES]],
  );
  return rows.map((row) => present(row, accountId));
}

export async function createFamilyGoal(input: {
  organizationId: string;
  accountId: string;
  athleteId: string;
  title: unknown;
  supportAction: unknown;
  targetDate?: unknown;
}): Promise<FamilyGoalForGuardian> {
  const title = cleanText(input.title, 'goal', FAMILY_GOAL_TITLE_MAX);
  const support = cleanText(input.supportAction, 'family support action', FAMILY_GOAL_SUPPORT_MAX);
  const targetDate = cleanDay(input.targetDate);
  if (!(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, input.athleteId))) {
    throw new NotFoundError(NOT_YOUR_CHILD);
  }
  const created = await queryOne<{ goal_id: string }>(
    `insert into pilot.family_goals
       (organization_id, athlete_id, title, support_action, target_date, created_by_account_id, created_by_role)
     values ($1, $2, $3, $4, $5::date, $6, 'parent')
     returning goal_id::text as goal_id`,
    [input.organizationId, input.athleteId, title, support, targetDate, input.accountId],
  );
  if (!created) throw new Error('Unable to save the goal.');
  return readOwn(input.organizationId, input.accountId, created.goal_id);
}

async function readOwn(organizationId: string, accountId: string, goalId: string): Promise<FamilyGoalForGuardian> {
  const row = await queryOne<GoalRow>(
    `${SELECT_GOAL}
      where g.organization_id = $1 and g.goal_id = $2::uuid`,
    [organizationId, goalId],
  );
  if (!row) throw new NotFoundError(NOT_YOURS);
  return present(row, accountId);
}

export type FamilyGoalChange =
  | { kind: 'edit'; title: unknown; supportAction: unknown; targetDate?: unknown }
  | { kind: 'done'; done: boolean }
  | { kind: 'retire' };

/** The SET clause for one change, its placeholders numbered from `first`. */
function changeClause(change: FamilyGoalChange, first: number): { set: string; values: unknown[] } {
  if (change.kind === 'edit') {
    let set = `title = $${first}, support_action = $${first + 1}`;
    const values: unknown[] = [
      cleanText(change.title, 'goal', FAMILY_GOAL_TITLE_MAX),
      cleanText(change.supportAction, 'family support action', FAMILY_GOAL_SUPPORT_MAX),
    ];
    // Left out, the saved target date stays; null (or '') clears it.
    if (change.targetDate !== undefined) {
      set += `, target_date = $${first + 2}::date`;
      values.push(cleanDay(change.targetDate));
    }
    return { set, values };
  }
  if (change.kind === 'done') {
    // Ticking an already-done goal keeps its time; the database refuses a rewrite.
    return {
      set: change.done
        ? `state = 'completed', completed_at = coalesce(completed_at, now())`
        : `state = 'active', completed_at = null`,
      values: [],
    };
  }
  return { set: 'retired_at = now()', values: [] };
}

/** Change a goal THIS guardian wrote, for a child linked to them now. */
export async function updateFamilyGoal(input: {
  organizationId: string;
  accountId: string;
  goalId: string;
  change: FamilyGoalChange;
}): Promise<FamilyGoalForGuardian | null> {
  if (!UUID.test(input.goalId)) throw new NotFoundError(NOT_YOURS);
  const goal = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.family_goals
      where organization_id = $1 and goal_id = $2::uuid and retired_at is null
        and created_by_role = 'parent' and created_by_account_id = $3`,
    [input.organizationId, input.goalId, input.accountId],
  );
  if (!goal || !(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, goal.athlete_id))) {
    throw new NotFoundError(NOT_YOURS);
  }

  const { set, values } = changeClause(input.change, 4);

  // The ownership check repeated in the write: a goal retired, or handed to
  // nobody, between the check and here is the same 404, not a refused write.
  const written = await queryOne<{ goal_id: string }>(
    `update pilot.family_goals
        set ${set}, updated_by_account_id = $3, updated_by_role = 'parent'
      where organization_id = $1 and goal_id = $2::uuid and retired_at is null
        and created_by_role = 'parent' and created_by_account_id = $3
      returning goal_id::text as goal_id`,
    [input.organizationId, input.goalId, input.accountId, ...values],
  );
  if (!written) throw new NotFoundError(NOT_YOURS);
  return input.change.kind === 'retire' ? null : readOwn(input.organizationId, input.accountId, input.goalId);
}

// ---------------------------------------------------------------------------
// The staff side (PH-06b).

export interface FamilyGoalForStaff {
  goal_id: string;
  title: string;
  support_action: string;
  target_date: string | null;
  state: 'active' | 'completed';
  completed_at: string | null;
  set_by: string;
  /** Staff wrote it, so staff may change it. A guardian's goal is the guardian's (Q-2 A). */
  mine_to_change: boolean;
}

function presentForStaff(row: GoalRow): FamilyGoalForStaff {
  const staffGoal = isStaffRole(row.created_by_role);
  return {
    goal_id: row.goal_id,
    title: row.title,
    support_action: row.support_action,
    target_date: row.target_date,
    state: row.state,
    completed_at: row.completed_at,
    // Never which guardian: no name, no id (as barrier reports and family replies show staff).
    set_by: staffGoal ? staffFacingAuthorName(row.login_email, row.created_by_role, row.staff_display_name) : 'A guardian',
    mine_to_change: staffGoal,
  };
}

function staffWriter(actor: ActorIdentity): StaffRole {
  if (!isStaffRole(actor.role)) throw new Error('Forbidden: role not allowed');
  return actor.role;
}

/** Every live goal for one child of this gym, newest first. The caller has gated the athlete. */
export async function listFamilyGoalsForStaff(organizationId: string, athleteId: string): Promise<FamilyGoalForStaff[]> {
  const rows = await query<GoalRow>(
    `${SELECT_GOAL}
      where g.organization_id = $1 and g.athlete_id = $2 and g.retired_at is null
      order by g.created_at desc, g.goal_id`,
    [organizationId, athleteId],
  );
  return rows.map(presentForStaff);
}

async function readForStaff(organizationId: string, goalId: string): Promise<FamilyGoalForStaff> {
  const row = await queryOne<GoalRow>(`${SELECT_GOAL} where g.organization_id = $1 and g.goal_id = $2::uuid`, [organizationId, goalId]);
  if (!row) throw new NotFoundError(NOT_YOURS);
  return presentForStaff(row);
}

/** A staff goal for one child, written as the caller. The caller has gated the athlete. */
export async function createStaffFamilyGoal(input: {
  actor: ActorIdentity;
  athleteId: string;
  title: unknown;
  supportAction: unknown;
  targetDate?: unknown;
}): Promise<FamilyGoalForStaff> {
  const role = staffWriter(input.actor);
  const title = cleanText(input.title, 'goal', FAMILY_GOAL_TITLE_MAX);
  const support = cleanText(input.supportAction, 'family support action', FAMILY_GOAL_SUPPORT_MAX);
  const targetDate = cleanDay(input.targetDate);
  const created = await queryOne<{ goal_id: string }>(
    `insert into pilot.family_goals
       (organization_id, athlete_id, title, support_action, target_date, created_by_account_id, created_by_role)
     values ($1, $2, $3, $4, $5::date, $6, $7)
     returning goal_id::text as goal_id`,
    [input.actor.organizationId, input.athleteId, title, support, targetDate, input.actor.accountId, role],
  );
  if (!created) throw new Error('Unable to save the goal.');
  return readForStaff(input.actor.organizationId, created.goal_id);
}

/**
 * Edit, tick, untick or retire a STAFF goal of this gym. A guardian's goal is
 * the same 404 as a forged id: staff read it but never change it (Q-2 A).
 */
export async function updateStaffFamilyGoal(input: {
  actor: ActorIdentity;
  goalId: string;
  change: FamilyGoalChange;
}): Promise<FamilyGoalForStaff | null> {
  const role = staffWriter(input.actor);
  const organizationId = input.actor.organizationId;
  if (!UUID.test(input.goalId)) throw new NotFoundError(NOT_YOURS);
  const goal = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.family_goals
      where organization_id = $1 and goal_id = $2::uuid and retired_at is null
        and created_by_role = any($3::text[])`,
    [organizationId, input.goalId, [...STAFF_ROLES]],
  );
  if (!goal) throw new NotFoundError(NOT_YOURS);
  await assertActorCanAccessAthlete(input.actor, goal.athlete_id);

  const { set, values } = changeClause(input.change, 6);
  // The check repeated in the write: a goal retired between the check and
  // here is the same 404, not a refused write.
  const written = await queryOne<{ goal_id: string }>(
    `update pilot.family_goals
        set ${set}, updated_by_account_id = $3, updated_by_role = $4
      where organization_id = $1 and goal_id = $2::uuid and retired_at is null
        and created_by_role = any($5::text[])
      returning goal_id::text as goal_id`,
    [organizationId, input.goalId, input.actor.accountId, role, [...STAFF_ROLES], ...values],
  );
  if (!written) throw new NotFoundError(NOT_YOURS);
  return input.change.kind === 'retire' ? null : readForStaff(organizationId, input.goalId);
}
