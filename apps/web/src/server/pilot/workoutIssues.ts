import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query } from './db';

// The shape of an ISSUED workout: pilot.workout_issues (one row per act of
// issuing a template to one athlete) and pilot.workout_issue_steps (one row per
// step, tying an assignment to its block, its place in the order, its scale
// level, its contact level and the coach's note). Both tables are owned by
// infra/azure/pilot_slice_postgres_workout_issues_migration.sql; nothing here
// issues DDL.
//
// WRITTEN ONCE, INSIDE THE ISSUE'S OWN TRANSACTION. recordWorkoutIssue takes a
// transaction client and has no pooled form, so the structure cannot be
// written apart from the assignments it describes: both commit or neither
// does. The pooled `query` in this module is for the READ at the foot only.
// There is no UPDATE and no DELETE in this module. The rows leave only
// by cascade (the athlete or the assignment going).
//
// A READER JOINS ON THE ORGANIZATION. The step's foreign key is on
// assignment_id alone (pilot.drill_assignments has no wider key), so any read
// added here joins a step to its assignment on organization_id AND
// assignment_id.
//
// A SNAPSHOT. The step keeps what the template item said on the day and the
// issue keeps the template's name and version, so a workout reads as it was
// issued after the template is superseded or withdrawn.
//
// NOTHING IS JUDGED OR DEFAULTED. A null scale level ("the coach picks at
// delivery") is stored as null. The contact level is the coach's entry and is
// stored as written.
//
// AUTHORIZATION IS THE CALLER'S. issueWorkoutTemplate is the one caller; its
// route has passed the role gate and assertActorCanAccessAthlete, and the
// organization id is the session's.

/** One step of the workout as it is being issued. */
export interface WorkoutIssueStepInput {
  ordinal: number;
  block: string;
  scale_level: string | null;
  contact_level: string;
  coach_note: string | null;
  /** The template item this step was copied from. */
  template_item_id: string;
  /** The assignment this step became, written earlier on the same transaction. */
  assignment_id: string;
}

/**
 * Writes one issued workout and its steps on the caller's transaction and
 * returns the new issue id. A step list that is empty is a caller bug: an
 * issue with no steps would be a workout nothing can show.
 */
export async function recordWorkoutIssue(
  client: PoolClient,
  params: {
    organizationId: string;
    athleteId: string;
    template: { template_id: string; name: string; version: number };
    issuedByAccountId: string;
    steps: WorkoutIssueStepInput[];
  },
): Promise<string> {
  if (params.steps.length === 0) {
    throw new Error('recordWorkoutIssue: an issued workout has at least one step');
  }
  const issueId = randomUUID();
  await client.query(
    `insert into pilot.workout_issues
       (organization_id, issue_id, athlete_id, template_id, template_name, template_version, issued_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.organizationId,
      issueId,
      params.athleteId,
      params.template.template_id,
      params.template.name,
      params.template.version,
      params.issuedByAccountId,
    ],
  );

  // One statement for every step. The assignment is looked up in THIS
  // organization and for THIS athlete as the row is written, so a step can
  // never be tied to another gym's or another athlete's assignment: such an id
  // selects nothing, and the count below refuses the whole issue.
  const inserted = await client.query(
    `insert into pilot.workout_issue_steps
       (organization_id, issue_id, ordinal, block, scale_level, contact_level, coach_note,
        template_item_id, assignment_id)
     select $1, $2::uuid, s.ordinal, s.block, s.scale_level, s.contact_level, s.coach_note,
            s.template_item_id, a.assignment_id
     from unnest($4::integer[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
       as s(ordinal, block, scale_level, contact_level, coach_note, template_item_id, assignment_id)
     join pilot.drill_assignments a
       on a.assignment_id = s.assignment_id and a.organization_id = $1 and a.athlete_id = $3`,
    [
      params.organizationId,
      issueId,
      params.athleteId,
      params.steps.map((step) => step.ordinal),
      params.steps.map((step) => step.block),
      params.steps.map((step) => step.scale_level),
      params.steps.map((step) => step.contact_level),
      params.steps.map((step) => step.coach_note),
      params.steps.map((step) => step.template_item_id),
      params.steps.map((step) => step.assignment_id),
    ],
  );
  if (inserted.rowCount !== params.steps.length) {
    throw new Error('recordWorkoutIssue: a step named an assignment that is not this athlete\'s in this organization');
  }
  return issueId;
}

// ---------------------------------------------------------------------------
// READING AN ISSUED WORKOUT BACK
//
// NO ACCESS BOUNDARY OF ITS OWN, ON PURPOSE. The read is asked for a list of
// assignment ids and answers only about those. Each caller passes the ids its
// own, already-bounded read returned: the assignments route
// (getAthleteAssignments behind assertActorCanAccessAthlete) and the coach
// card list (listCoachCards: a coach's own cards for athletes that coach
// currently reaches, the whole gym for an organization admin). So a reader sees
// the shape of exactly the work they could already see and nothing else.
// Any later caller owes the same: ids from a read it has already bounded,
// never ids from a request. workoutIssuesSchemaOwnership.test.ts pins the
// callers.
//
// A workout comes back with the steps whose assignments were asked for, in the
// coach's order. A step whose assignment was not asked for (a status filter
// left it out) is not in it, and a workout with no step left is not returned.
// ---------------------------------------------------------------------------

/** One step of an issued workout: where the assignment sits and what the coach wrote beside it. */
export interface IssuedWorkoutStep {
  ordinal: number;
  block: string;
  /** Null when the coach left the level to be picked at delivery. */
  scale_level: string | null;
  /** The coach's entry, as written. */
  contact_level: string;
  coach_note: string | null;
  assignment_id: string;
}

/** An issued workout as staff receive it. */
export interface IssuedWorkout {
  issue_id: string;
  athlete_id: string;
  template_name: string;
  template_version: number;
  /** A Date on the server (timestamptz); the ISO string a reader receives once the route serialises it. */
  issued_at: string;
  issued_by_account_id: string;
  steps: IssuedWorkoutStep[];
}

/**
 * An issued workout as the athlete receives it (OD-2026-10-06-025 ruling 2:
 * families see the coach's display name, never the internal account id).
 */
export type FamilyIssuedWorkout = Omit<IssuedWorkout, 'issued_by_account_id'> & {
  issued_by_name: string;
};

type IssuedStepRow = Omit<IssuedWorkout, 'steps'> & IssuedWorkoutStep;

/**
 * The issued workouts these assignments are steps of, newest first, each with
 * its steps in order. Assignments that are not a step of any workout (a Coach
 * Card, a gap-driven assignment, a template issued before the shape was kept)
 * simply have no entry.
 */
export async function listIssuedWorkoutsForAssignments(
  organizationId: string,
  assignmentIds: readonly string[],
): Promise<IssuedWorkout[]> {
  if (assignmentIds.length === 0) {
    return [];
  }
  // The step is joined to its assignment on the organization as well as the id
  // (the foreign key is on assignment_id alone), and the assignment must be
  // the issue's own athlete's: a row that fails either is not a step of this
  // workout and is not returned.
  const rows = await query<IssuedStepRow>(
    `select i.issue_id::text as issue_id, i.athlete_id, i.template_name, i.template_version,
            i.issued_at, i.issued_by_account_id,
            s.ordinal, s.block, s.scale_level, s.contact_level, s.coach_note, s.assignment_id
     from pilot.workout_issue_steps s
     join pilot.workout_issues i
       on i.organization_id = s.organization_id and i.issue_id = s.issue_id
     join pilot.drill_assignments a
       on a.organization_id = s.organization_id and a.assignment_id = s.assignment_id
      and a.athlete_id = i.athlete_id
     where s.organization_id = $1 and s.assignment_id = any($2::text[])
     order by i.issued_at desc, i.issue_id asc, s.ordinal asc`,
    [organizationId, [...assignmentIds]],
  );

  const workouts = new Map<string, IssuedWorkout>();
  for (const row of rows) {
    let workout = workouts.get(row.issue_id);
    if (!workout) {
      workout = {
        issue_id: row.issue_id,
        athlete_id: row.athlete_id,
        template_name: row.template_name,
        template_version: row.template_version,
        issued_at: row.issued_at,
        issued_by_account_id: row.issued_by_account_id,
        steps: [],
      };
      workouts.set(row.issue_id, workout);
    }
    workout.steps.push({
      ordinal: row.ordinal,
      block: row.block,
      scale_level: row.scale_level,
      contact_level: row.contact_level,
      coach_note: row.coach_note,
      assignment_id: row.assignment_id,
    });
  }
  return [...workouts.values()];
}

// Unreachable while nameFor answers for every id it is asked; here so the
// field is a phrase, never undefined, if it ever does not.
const FAMILY_ISSUED_BY_FLOOR = 'Your coach';

/**
 * The family projection of issued workouts. Named field by field, never
 * spread: a spread carries the account id, and every column a later change
 * adds, to a family without anyone deciding it should. `nameFor` is asked once
 * per distinct coach; the route passes its cached getCoachDisplayName.
 */
export async function toFamilyIssuedWorkouts(
  workouts: IssuedWorkout[],
  nameFor: (accountId: string) => Promise<string>,
): Promise<FamilyIssuedWorkout[]> {
  const names = new Map<string, string>();
  await Promise.all(
    Array.from(new Set(workouts.map((workout) => workout.issued_by_account_id))).map(async (accountId) => {
      names.set(accountId, await nameFor(accountId));
    }),
  );
  return workouts.map((workout): FamilyIssuedWorkout => ({
    issue_id: workout.issue_id,
    athlete_id: workout.athlete_id,
    template_name: workout.template_name,
    template_version: workout.template_version,
    issued_at: workout.issued_at,
    issued_by_name: names.get(workout.issued_by_account_id) ?? FAMILY_ISSUED_BY_FLOOR,
    steps: workout.steps.map((step): IssuedWorkoutStep => ({
      ordinal: step.ordinal,
      block: step.block,
      scale_level: step.scale_level,
      contact_level: step.contact_level,
      coach_note: step.coach_note,
      assignment_id: step.assignment_id,
    })),
  }));
}
