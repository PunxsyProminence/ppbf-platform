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
 * The staff side (a coach adding or ticking a family goal) is PH-06b.
 */
import { query, queryOne } from './db';
import { NotFoundError, ValidationError } from './errors';
import { isGuardianLinkedToAthlete } from './guardianAccess';
import { deriveCoachDisplayName } from '@/src/shared/coachDisplayName';

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
}

const SELECT_GOAL = `
  select g.goal_id::text as goal_id, g.title, g.support_action,
         to_char(g.target_date, 'YYYY-MM-DD') as target_date,
         g.state,
         to_char(g.completed_at at time zone 'UTC', ${ISO_UTC}) as completed_at,
         g.created_by_account_id, g.created_by_role, a.login_email
    from pilot.family_goals g
    left join pilot.accounts a on a.account_id = g.created_by_account_id`;

function present(row: GoalRow, accountId: string): FamilyGoalForGuardian {
  const mine = row.created_by_role === 'parent' && row.created_by_account_id === accountId;
  return {
    goal_id: row.goal_id,
    title: row.title,
    support_action: row.support_action,
    target_date: row.target_date,
    state: row.state,
    completed_at: row.completed_at,
    set_by: mine ? 'You' : row.created_by_role === 'coach' ? deriveCoachDisplayName(row.login_email) : 'Your gym',
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
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
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
             or g.created_by_role in ('coach', 'organization_admin', 'admin'))
      order by g.created_at desc, g.goal_id`,
    [organizationId, athleteId, accountId],
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

  const { change } = input;
  let set: string;
  let values: unknown[];
  if (change.kind === 'edit') {
    set = 'title = $4, support_action = $5, target_date = $6::date';
    values = [
      cleanText(change.title, 'goal', FAMILY_GOAL_TITLE_MAX),
      cleanText(change.supportAction, 'family support action', FAMILY_GOAL_SUPPORT_MAX),
      cleanDay(change.targetDate),
    ];
  } else if (change.kind === 'done') {
    // Ticking an already-done goal keeps its time; the database refuses a rewrite.
    set = change.done
      ? `state = 'completed', completed_at = coalesce(completed_at, now())`
      : `state = 'active', completed_at = null`;
    values = [];
  } else {
    set = 'retired_at = now()';
    values = [];
  }

  await query(
    `update pilot.family_goals
        set ${set}, updated_by_account_id = $3, updated_by_role = 'parent'
      where organization_id = $1 and goal_id = $2::uuid`,
    [input.organizationId, input.goalId, input.accountId, ...values],
  );
  return change.kind === 'retire' ? null : readOwn(input.organizationId, input.accountId, input.goalId);
}
