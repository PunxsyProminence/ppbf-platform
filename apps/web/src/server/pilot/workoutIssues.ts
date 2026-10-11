import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

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
// does. There is no UPDATE and no DELETE in this module. The rows leave only
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
