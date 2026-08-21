import { randomUUID } from 'node:crypto';

import {
  accessibleAthleteIds,
  athleteIdsForCoach,
  isOrganizationAdminRole,
  type ActorIdentity,
} from './access';
import { query, queryOne } from './db';
import { ValidationError } from './errors';
import {
  ASSIGNMENT_DRILL_JOIN,
  ASSIGNMENT_FIELDS,
  type DrillAssignment,
} from './progression';

// The shared projection plus the one column this feature's migration adds.
// Only card reads name it, so an assignment surface that predates Coach
// Cards keeps working on a database that has not taken the migration yet.
const CARD_FIELDS = `${ASSIGNMENT_FIELDS}, a.issuance_id`;

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
  // Shared tag across the rows one group Coach Card issuance created; null
  // on an individual card. It lives on the CARD row rather than on
  // DrillAssignment because the column arrives with this feature's own
  // migration -- see the note on ASSIGNMENT_FIELDS in progression.ts.
  issuance_id: string | null;
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
    select ${CARD_FIELDS}
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

  // status comes back with the row rather than being filtered in the WHERE,
  // because the two refusals are deliberately DIFFERENT shapes. A program in
  // another gym must be indistinguishable from one that does not exist
  // (null -> hiddenNotFound at the route), or the endpoint becomes a probe
  // for other gyms' program ids. An ARCHIVED program in the caller's OWN gym
  // is not a secret -- a coach reads it in the catalog they are shown -- so
  // hiding it there would only leave them staring at a 404 for a program
  // they can see. They get told why.
  const program = await queryOne<{ program_id: string; program_name: string; status: string }>(
    `select program_id, program_name, status from pilot.programs
     where organization_id = $1 and program_id = $2`,
    [organizationId, params.programId],
  );
  if (!program) {
    return null;
  }

  // Archiving a program deliberately does NOT touch its membership rows --
  // enrollment history outlives the group it names (see programs.ts). That
  // is precisely why this check has to exist: without it, the active
  // memberships of a closed group are still found and real work is still
  // issued to it. The form already excludes archived programs from new
  // work; this is the same rule where it is actually enforceable, for a
  // program_id that arrived by any other route.
  if (program.status !== 'active') {
    throw new ValidationError(
      `That program is archived, so it cannot be issued new work. Reactivate "${program.program_name}" first.`,
      'PROGRAM_ARCHIVED',
    );
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
 * Every Coach Card the actor may currently read -- gap_id IS NULL is what
 * makes a row a card. Each row carries the athlete's name and the card's
 * full completion history, so the coach's list shows per-athlete progress
 * and offers verify/dispute without a second round trip.
 *
 * TWO SCOPES, AND ONLY ONE OF THEM IS THE BOUNDARY.
 *
 * The boundary is athleteIdsForCoach -- the central access contract added
 * in #546 (coach_id of record UNION active, unexpired coach_coverage),
 * evaluated NOW, on every read. The issuer filter that sits beside it is a
 * convenience ("cards I issued"), not a permission.
 *
 * That distinction is the whole point. This function first shipped scoped
 * by assigned_by_account_id ALONE, and issuer identity never changes: once
 * a coach had issued a card, they kept reading that athlete's name, their
 * completion notes and their verification state forever -- through a roster
 * reassignment, and past the expiry of the temporary coverage grant that
 * was the only reason they could reach the athlete in the first place.
 * assertActorCanAccessAthlete would have refused them, and the verify
 * branch of /api/pilot/progression/completions DOES recheck before it
 * flips anything, so the write was already bounded while the read was not.
 * A read of a child's notes is not a lesser thing than a write.
 *
 * An organization admin administers the whole gym's records, so their read
 * is org-wide and carries no issuer filter -- unchanged, and the reason the
 * card does not disappear from the gym when a coach loses access to it.
 *
 * Note the empty-set case is a real answer, not a missing filter: a coach
 * who currently reaches nobody reads no cards. `= any('{}')` is false for
 * every row, which is exactly right; passing null would have meant
 * "unbounded" and is reserved for the admin branch.
 */
export async function listCoachCards(actor: ActorIdentity): Promise<CoachCardRow[]> {
  const organizationId = actor.organizationId;
  const isAdmin = isOrganizationAdminRole(actor.role);
  const issuedByAccountId = isAdmin ? null : actor.accountId;
  const athleteIds = isAdmin ? null : await athleteIdsForCoach(organizationId, actor.accountId);
  return query<CoachCardRow>(
    `select ${CARD_FIELDS},
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
       -- The access boundary, re-evaluated on every read.
       and ($3::text[] is null or a.athlete_id = any($3::text[]))
       -- "Cards I issued": a convenience filter, never the boundary.
       and ($2::text is null or a.assigned_by_account_id = $2)
     order by a.assigned_at desc, ath.full_name asc, a.athlete_id asc`,
    [organizationId, issuedByAccountId, athleteIds],
  );
}
