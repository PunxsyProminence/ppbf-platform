import { randomUUID } from 'node:crypto';

import { accessibleAthleteIds, type ActorIdentity } from './access';
import { query, queryOne } from './db';
import {
  ASSIGNMENT_DRILL_JOIN,
  ASSIGNMENT_FIELDS,
  type DrillAssignment,
} from './progression';

// Coach Cards: the thinnest operational layer over the existing assignment
// spine. A card IS a pilot.drill_assignments row -- issued by a coach with
// no detection gap behind it (gap_id NULL, relaxed by
// pilot_slice_postgres_coach_cards_migration.sql), either to one athlete or
// to every active member of a pilot.programs program. The athlete logs
// completions against it and the coach verifies them through the
// completions machinery that already exists; nothing here invents a second
// engine.
//
// This module deliberately reuses progression.ts's ASSIGNMENT_FIELDS
// projection and drill join so a card and a gap-driven assignment are the
// same shape on every surface that reads them.

/** A completion as the coach's card list carries it, aggregated per card. */
export interface CoachCardCompletion {
  completion_id: string;
  completed_at: string;
  reps_completed: number | null;
  notes: string;
  verification_status: 'pending' | 'verified' | 'disputed';
  verified_at: string | null;
}

/** One card row plus the athlete's name and its completion history. */
export interface CoachCardRow extends DrillAssignment {
  athlete_name: string;
  completions: CoachCardCompletion[];
}

export interface IssuedCardReport {
  athlete_id: string;
  athlete_name: string;
  assignment_id: string;
}

export interface SkippedMemberReport {
  athlete_id: string;
  athlete_name: string;
}

export interface ProgramIssuanceResult {
  program_id: string;
  program_name: string;
  issuance_id: string;
  issued: IssuedCardReport[];
  // Active members of the program the ISSUING COACH cannot access under
  // accessibleAthleteIds (assigned athletes plus active coverage). Their ids
  // and names are returned so the coach's report can say honestly who did
  // NOT get the card. This is not a disclosure: coach-visible athlete names
  // are org-wide by existing doctrine (see /api/pilot/athletes/list, where a
  // coach reads every athlete's name and gym status to plan a floor).
  skipped: SkippedMemberReport[];
}

interface CardContent {
  drillName: string;
  drillDescription: string;
  drillDifficulty: string;
  drillId?: string | null;
  repCount?: number;
  durationMinutes?: number;
  frequencyPerWeek?: number;
  dueDate?: string;
}

function newAssignmentId(): string {
  // Same shape assignDrill writes, so a card is indistinguishable from any
  // other assignment wherever an assignment_id travels.
  return `assignment_${Date.now()}_${randomUUID().substring(0, 8)}`;
}

/**
 * Issue an individual Coach Card: one gap-free assignment for one athlete.
 *
 * Same write as assignDrill minus the gap -- no progression_gaps row is
 * touched because none exists to touch. Authorization
 * (assertActorCanAccessAthlete) is enforced at the route exactly as it is
 * for gap-driven assignments. A single INSERT is atomic on its own, so no
 * explicit transaction is opened.
 */
export async function issueCoachCard(params: {
  organizationId: string;
  athleteId: string;
  assignedByAccountId: string;
} & CardContent): Promise<DrillAssignment> {
  const rows = await query<DrillAssignment>(
    `with a as (
      insert into pilot.drill_assignments (
        assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id,
        drill_name, drill_description, drill_difficulty, rep_count, duration_minutes,
        frequency_per_week, due_date, drill_id, issuance_id, status, completion_percentage
      ) values ($1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null, 'assigned', 0)
      returning assignment_id, organization_id, gap_id, athlete_id, drill_id, drill_name,
               drill_description, drill_difficulty, rep_count, duration_minutes,
               frequency_per_week, due_date, status, completion_percentage,
               assigned_by_account_id, assigned_at, issuance_id, created_at
    )
    select ${ASSIGNMENT_FIELDS}
    from a
    ${ASSIGNMENT_DRILL_JOIN}`,
    [
      newAssignmentId(),
      params.organizationId,
      params.athleteId,
      params.assignedByAccountId,
      params.drillName,
      params.drillDescription,
      params.drillDifficulty,
      params.repCount || null,
      params.durationMinutes || null,
      params.frequencyPerWeek || null,
      params.dueDate || null,
      params.drillId || null,
    ],
  );
  return rows[0];
}

/**
 * Issue a group Coach Card: one gap-free assignment per authorized ACTIVE
 * member of a program, all sharing one generated issuance_id.
 *
 * Resolution is org-scoped end to end: the program is looked up by
 * (organization_id, program_id) and a miss returns null so the route can
 * answer with hiddenNotFound -- another gym's program_id must read as
 * absent, never as "exists but not yours". Members come from
 * pilot.program_memberships joined by (organization_id, program_name),
 * ACTIVE rows only -- lapsed and ended memberships are history, not the
 * group. The member set is then intersected with accessibleAthleteIds for
 * the acting coach; members outside that set are reported as skipped (see
 * SkippedMemberReport for why returning their names is not a leak).
 *
 * All issued rows land in ONE multi-row INSERT (the
 * rosterImport#createAthletesBatch pattern): a single statement is a single
 * transaction, so a group card can never half-issue.
 */
export async function issueCoachCardToProgram(params: {
  actor: ActorIdentity;
  programId: string;
} & CardContent): Promise<ProgramIssuanceResult | null> {
  const organizationId = params.actor.organizationId;

  const program = await queryOne<{ program_id: string; program_name: string }>(
    `select program_id, program_name from pilot.programs
     where organization_id = $1 and program_id = $2`,
    [organizationId, params.programId],
  );
  if (!program) {
    return null;
  }

  const members = await query<{ athlete_id: string; athlete_name: string }>(
    `select m.athlete_id, a.full_name as athlete_name
     from pilot.program_memberships m
     join pilot.athletes a
       on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id
     where m.organization_id = $1 and m.program_name = $2 and m.status = 'active'
     order by a.full_name asc, m.athlete_id asc`,
    [organizationId, program.program_name],
  );

  const accessible = await accessibleAthleteIds(
    params.actor,
    members.map((member) => member.athlete_id),
  );
  const authorized = members.filter((member) => accessible.has(member.athlete_id));
  const skipped = members
    .filter((member) => !accessible.has(member.athlete_id))
    .map(({ athlete_id, athlete_name }) => ({ athlete_id, athlete_name }));

  const issuanceId = `issuance_${Date.now()}_${randomUUID().substring(0, 8)}`;

  if (authorized.length === 0) {
    // Nothing to write: the issuance_id identifies this attempt in the
    // report, and by construction no row carries it.
    return {
      program_id: program.program_id,
      program_name: program.program_name,
      issuance_id: issuanceId,
      issued: [],
      skipped,
    };
  }

  // Shared values once, then two per member. $1..$11 are the card itself;
  // each member tuple appends (assignment_id, athlete_id).
  const values: unknown[] = [
    organizationId,
    params.actor.accountId,
    params.drillName,
    params.drillDescription,
    params.drillDifficulty,
    params.repCount || null,
    params.durationMinutes || null,
    params.frequencyPerWeek || null,
    params.dueDate || null,
    params.drillId || null,
    issuanceId,
  ];
  const tuples = authorized.map((member, index) => {
    const base = 12 + index * 2;
    values.push(newAssignmentId(), member.athlete_id);
    return `($${base}, $1, null, $${base + 1}, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'assigned', 0)`;
  });

  const inserted = await query<{ assignment_id: string; athlete_id: string }>(
    `insert into pilot.drill_assignments (
       assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id,
       drill_name, drill_description, drill_difficulty, rep_count, duration_minutes,
       frequency_per_week, due_date, drill_id, issuance_id, status, completion_percentage
     ) values ${tuples.join(', ')}
     returning assignment_id, athlete_id`,
    values,
  );
  const assignmentByAthlete = new Map(inserted.map((row) => [row.athlete_id, row.assignment_id]));

  return {
    program_id: program.program_id,
    program_name: program.program_name,
    issuance_id: issuanceId,
    issued: authorized.map((member) => ({
      athlete_id: member.athlete_id,
      athlete_name: member.athlete_name,
      assignment_id: assignmentByAthlete.get(member.athlete_id) as string,
    })),
    skipped,
  };
}

/**
 * Every Coach Card in the organization -- gap_id IS NULL is the definition
 * -- optionally narrowed to one issuer. A coach reads their own issued
 * cards (issuedByAccountId = their account); an admin passes null and reads
 * them all. Each row carries the athlete's name and the card's full
 * completion history so the coach's list can show per-athlete progress and
 * offer verify/dispute per completion without a second round trip.
 */
export async function listCoachCards(
  organizationId: string,
  issuedByAccountId: string | null,
): Promise<CoachCardRow[]> {
  return query<CoachCardRow>(
    `select ${ASSIGNMENT_FIELDS},
            ath.full_name as athlete_name,
            coalesce(comp.completions, '[]'::json) as completions
     from pilot.drill_assignments a
     ${ASSIGNMENT_DRILL_JOIN}
     join pilot.athletes ath
       on ath.organization_id = a.organization_id and ath.athlete_id = a.athlete_id
     left join lateral (
       select json_agg(json_build_object(
                'completion_id', c.completion_id,
                'completed_at', c.completed_at,
                'reps_completed', c.reps_completed,
                'notes', c.notes,
                'verification_status', c.verification_status,
                'verified_at', c.verified_at
              ) order by c.completed_at desc) as completions
       from pilot.assignment_completions c
       where c.organization_id = a.organization_id and c.assignment_id = a.assignment_id
     ) comp on true
     where a.organization_id = $1
       and a.gap_id is null
       and ($2::text is null or a.assigned_by_account_id = $2)
     order by a.assigned_at desc, ath.full_name asc, a.athlete_id asc`,
    [organizationId, issuedByAccountId],
  );
}
