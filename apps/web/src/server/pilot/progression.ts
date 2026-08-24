import { query, queryOne, withTransaction } from './db';
import { randomUUID } from 'node:crypto';

// severity is a text column, so `order by severity desc` sorts alphabetically
// and puts 'medium' above 'critical'. Rank the vocabulary explicitly instead.
// Anything outside it sorts last rather than silently displacing a real
// severity.
const SEVERITY_RANK_SQL = `case severity
      when 'critical' then 1
      when 'high' then 2
      when 'medium' then 3
      when 'low' then 4
      else 5
    end`;

export interface ProgressionGap {
  gap_id: string;
  athlete_id: string;
  gap_type: 'technique' | 'strength' | 'endurance' | 'skill' | 'mental' | 'tactical';
  gap_description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'identified' | 'assigned' | 'in_progress' | 'completed' | 'deferred';
  created_at: string;
}

export interface DrillAssignment {
  assignment_id: string;
  // Null on a Coach Card (a coach-issued assignment with no detection gap
  // behind it -- see coachCards.ts); always set on a gap-driven assignment.
  gap_id: string | null;
  athlete_id: string;
  // The drill this assignment anchors to, when it has one. Null on every
  // assignment written before drills had identity, and on any assignment a
  // coach still types out by hand.
  drill_id: string | null;
  // What the coach wrote on the day. This is the record of what was actually
  // assigned and is never rewritten -- renaming the drill does not touch it.
  drill_name: string;
  drill_description: string;
  // The drill as it stands now, for a surface to render. Falls back to the
  // typed text when there is no anchor, so a reader never has to decide which
  // field to draw and never draws an empty one.
  drill_display_name: string;
  drill_display_description: string;
  // Null rather than empty when the assignment has no anchor: there is no
  // drill to describe, so a reader renders nothing rather than an empty shell.
  drill_category: string | null;
  drill_cues: string[] | null;
  drill_difficulty: 'beginner' | 'intermediate' | 'advanced' | 'elite';
  rep_count: number | null;
  duration_minutes: number | null;
  frequency_per_week: number | null;
  due_date: string | null;
  status: 'assigned' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';
  completion_percentage: number;
  // Who issued the work and when. Always present on the row (the column is
  // NOT NULL); projected so the coach-facing card list never has to guess
  // whose issuance it is looking at.
  assigned_by_account_id: string;
  assigned_at: string;
  created_at: string;
}

// One projection for every assignment read, so the display fields cannot exist
// on one surface and not another. The join is composite and organization-scoped
// exactly like the foreign key -- a drill_id alone would reach another gym's
// drill. Exported for coachCards.ts, which reads the same rows and must not
// grow a second projection that can drift from this one.
//
// EVERY COLUMN NAMED HERE MUST EXIST WITHOUT THE COACH-CARDS MIGRATION.
// This projection is the read path for /athlete/progression-intelligence,
// /coach/progression-intelligence and the assignments API -- all of which
// shipped long before Coach Cards. issuance_id was briefly listed here and
// it is added by pilot_slice_postgres_coach_cards_migration.sql, so every
// one of those pre-existing reads started failing with `column
// "issuance_id" does not exist` on any database that had not yet taken that
// migration. drillsPersistence.pg.test.ts (base schema + progression +
// drills, exactly a pre-cards database) caught it; in production the same
// mistake is a deploy that 500s every assignment read until the migration
// lands, which is the ordering hazard apply-migrations.yml exists to avoid.
// coachCards.ts adds issuance_id to its OWN projection instead -- a card
// cannot exist without that migration, so only the card reads require it.
//
// assigned_by_account_id and assigned_at are safe here: both are NOT NULL
// columns of the original progression migration.
export const ASSIGNMENT_FIELDS = `a.assignment_id, a.gap_id, a.athlete_id, a.drill_id,
           a.drill_name, a.drill_description,
           coalesce(d.name, a.drill_name) as drill_display_name,
           coalesce(nullif(d.focus, ''), a.drill_description) as drill_display_description,
           d.category as drill_category, d.cues as drill_cues,
           a.drill_difficulty, a.rep_count, a.duration_minutes, a.frequency_per_week,
           a.due_date, a.status, a.completion_percentage,
           a.assigned_by_account_id, a.assigned_at, a.created_at`;

export const ASSIGNMENT_DRILL_JOIN = `left join pilot.drills d
      on d.organization_id = a.organization_id and d.drill_id = a.drill_id`;

export interface AssignmentCompletion {
  completion_id: string;
  assignment_id: string;
  completed_at: string;
  reps_completed: number | null;
  notes: string;
  verification_status: 'pending' | 'verified' | 'disputed';
  verified_at: string | null;
}

export async function createProgressionGap(params: {
  organizationId: string;
  athleteId: string;
  coachAccountId: string;
  gapType: string;
  gapDescription: string;
  severity: string;
  detectedFrom: string;
  detectedFromId?: string;
  detectionData?: Record<string, unknown>;
}): Promise<ProgressionGap> {
  // Session ID generation - using crypto.randomUUID for secure randomness
  const gapId = `gap_${Date.now()}_${randomUUID().substring(0, 8)}`;

  const result = await query<ProgressionGap>(
    `insert into pilot.progression_gaps (
      gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description,
      severity, detected_from, detected_from_id, detection_data, status
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'identified')
    returning gap_id, athlete_id, gap_type, gap_description, severity, status, created_at`,
    [
      gapId,
      params.organizationId,
      params.athleteId,
      params.coachAccountId,
      params.gapType,
      params.gapDescription,
      params.severity,
      params.detectedFrom,
      params.detectedFromId || null,
      JSON.stringify(params.detectionData || {}),
    ],
  );

  return result[0];
}

/**
 * Records a drill assignment against a gap.
 *
 * drillName and drillDescription are always written, with or without an anchor:
 * they are what was assigned that day, and a coach who typed their own wording
 * over a drill from the library keeps that wording forever. drillId is the
 * anchor, nullable because an assignment can still be typed out entirely by
 * hand, and because every assignment written before drills had identity carries
 * only the text.
 */
export async function assignDrill(params: {
  organizationId: string;
  gapId: string;
  athleteId: string;
  assignedByAccountId: string;
  drillName: string;
  drillDescription: string;
  drillDifficulty: string;
  drillId?: string | null;
  repCount?: number;
  durationMinutes?: number;
  frequencyPerWeek?: number;
  dueDate?: string;
}): Promise<DrillAssignment> {
  // Using crypto.randomUUID for secure randomness
  const assignmentId = `assignment_${Date.now()}_${randomUUID().substring(0, 8)}`;

  // One transaction: a drill assigned against a gap still marked 'identified'
  // keeps showing up as unaddressed work, so the pair must commit together or
  // not at all.
  return withTransaction(async (client) => {
    // The created row comes back through the same drill join every other read
    // uses, so the caller gets the display fields immediately rather than
    // having to fetch the assignment again to learn what to draw.
    const result = await client.query<DrillAssignment>(
      `with a as (
        insert into pilot.drill_assignments (
          assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id,
          drill_name, drill_description, drill_difficulty, rep_count, duration_minutes,
          frequency_per_week, due_date, drill_id, status, completion_percentage
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'assigned', 0)
        returning assignment_id, organization_id, gap_id, athlete_id, drill_id, drill_name,
                 drill_description, drill_difficulty, rep_count, duration_minutes,
                 frequency_per_week, due_date, status, completion_percentage,
                 assigned_by_account_id, assigned_at, created_at
      )
      select ${ASSIGNMENT_FIELDS}
      from a
      ${ASSIGNMENT_DRILL_JOIN}`,
      [
        assignmentId,
        params.organizationId,
        params.gapId,
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

    // Update gap status to assigned. Scoped by organization_id so a gap_id
    // from another organization can never be mutated by this call.
    await client.query(
      `update pilot.progression_gaps set status = 'assigned' where gap_id = $1 and organization_id = $2`,
      [params.gapId, params.organizationId],
    );

    return result.rows[0];
  });
}

/**
 * Recompute assignment completion_percentage and status from the completion
 * count. frequency_per_week is the intended session cadence for the week; when
 * set, percentage is count / frequency capped at 100. When unset, each log is
 * worth 25% so four sessions close the loop without requiring a frequency.
 * Status advances assigned → in_progress on the first log, and to completed at
 * 100%. Cancelled assignments are left alone.
 */
async function touchAssignmentProgress(
  client: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }> },
  organizationId: string,
  assignmentId: string,
): Promise<void> {
  const assignmentRows = await client.query<{
    frequency_per_week: number | null;
    status: string;
  }>(
    `select frequency_per_week, status
     from pilot.drill_assignments
     where organization_id = $1 and assignment_id = $2
     for update`,
    [organizationId, assignmentId],
  );
  const assignment = assignmentRows.rows[0];
  if (!assignment || assignment.status === 'cancelled') {
    return;
  }

  const countRows = await client.query<{ n: string }>(
    `select count(*)::text as n
     from pilot.assignment_completions
     where organization_id = $1 and assignment_id = $2`,
    [organizationId, assignmentId],
  );
  const count = Number(countRows.rows[0]?.n ?? 0);
  const frequency = assignment.frequency_per_week;
  const percentage =
    count <= 0
      ? 0
      : frequency && frequency > 0
        ? Math.min(100, Math.round((count / frequency) * 100))
        : Math.min(100, count * 25);

  let nextStatus = assignment.status;
  if (percentage >= 100) {
    nextStatus = 'completed';
  } else if (count > 0 && assignment.status === 'assigned') {
    nextStatus = 'in_progress';
  }

  await client.query(
    `update pilot.drill_assignments
     set completion_percentage = $1, status = $2
     where organization_id = $3 and assignment_id = $4`,
    [percentage, nextStatus, organizationId, assignmentId],
  );
}

export async function recordCompletion(params: {
  organizationId: string;
  assignmentId: string;
  athleteId: string;
  repsCompleted?: number;
  notes?: string;
}): Promise<AssignmentCompletion> {
  // Using crypto.randomUUID for secure randomness
  const completionId = `completion_${Date.now()}_${randomUUID().substring(0, 8)}`;
  const now = new Date().toISOString();

  // Insert and percentage update must commit together: a completion that does
  // not move the parent gauge leaves the product surface lying about progress.
  return withTransaction(async (client) => {
    const result = await client.query<AssignmentCompletion>(
      `insert into pilot.assignment_completions (
        completion_id, organization_id, assignment_id, athlete_id, completed_at, reps_completed, notes, verification_status
      ) values ($1, $2, $3, $4, $5, $6, $7, 'pending')
      returning completion_id, assignment_id, completed_at, reps_completed, notes, verification_status, verified_at`,
      [
        completionId,
        params.organizationId,
        params.assignmentId,
        params.athleteId,
        now,
        params.repsCompleted || null,
        params.notes || '',
      ],
    );

    await touchAssignmentProgress(client, params.organizationId, params.assignmentId);

    return result.rows[0];
  });
}

/**
 * The completion row with its athlete, for authorisation checks that must run
 * BEFORE any write. Verification needs to know whose completion this is; asking
 * after the flip means the flip already happened for a completion the caller
 * had no business touching.
 */
export async function getCompletionById(
  organizationId: string,
  completionId: string,
): Promise<{ completion_id: string; assignment_id: string; athlete_id: string } | null> {
  const rows = await query<{ completion_id: string; assignment_id: string; athlete_id: string }>(
    `select completion_id, assignment_id, athlete_id
     from pilot.assignment_completions
     where organization_id = $1 and completion_id = $2`,
    [organizationId, completionId],
  );
  return rows[0] ?? null;
}

/**
 * Mark a completion verified or disputed, within one organization.
 *
 * organizationId is REQUIRED, and the update is scoped by it. It was briefly
 * optional, with an unscoped fallback that updated by completion_id alone --
 * and a completion_id is not a secret, so that path would let a caller in one
 * gym flip a record belonging to another. Both call sites already passed the
 * organization, so nothing depended on the fallback; it was a door left open
 * for whoever forgot the argument next, and nothing would have failed loudly
 * enough to notice.
 *
 * getCompletionById above is the read that answers "whose is this" before the
 * flip. This scope is the second lock rather than a substitute for it: the read
 * decides whether the caller may act, and the WHERE clause makes certain the
 * write lands only where the read looked.
 *
 * Returns null when no row matched, which is also what a caller sees when the
 * completion belongs to a different gym. The route renders that as
 * hiddenNotFound() rather than a 403, so a probe cannot use the difference
 * between "does not exist" and "not yours" to enumerate another gym's records.
 */
export async function verifyCompletion(
  completionId: string,
  verifiedByAccountId: string,
  verified: boolean,
  organizationId: string,
): Promise<AssignmentCompletion | null> {
  const now = new Date().toISOString();
  const status = verified ? 'verified' : 'disputed';

  const result = await query<AssignmentCompletion>(
    `update pilot.assignment_completions
     set verification_status = $1, verified_by_account_id = $2, verified_at = $3
     where completion_id = $4 and organization_id = $5
     returning completion_id, assignment_id, completed_at, reps_completed, notes, verification_status, verified_at`,
    [status, verifiedByAccountId, now, completionId, organizationId],
  );
  return result[0] ?? null;
}

export async function getAthleteGaps(
  organizationId: string,
  athleteId: string,
  status?: string,
): Promise<ProgressionGap[]> {
  let sql = `
    select gap_id, athlete_id, gap_type, gap_description, severity, status, created_at
    from pilot.progression_gaps
    where organization_id = $1 and athlete_id = $2
  `;
  const params: unknown[] = [organizationId, athleteId];

  if (status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ` order by ${SEVERITY_RANK_SQL}, created_at desc`;

  return query<ProgressionGap>(sql, params);
}

/**
 * gap_id + detected_from only, for the same rows getAthleteGaps would return
 * (same organization/athlete/status scoping). detected_from is never sent to
 * an athlete or parent as-is -- progressionSuggestions.ts's
 * getGapJustifications reads it server-side to decide which rollup fields, if
 * any, justify a given gap, then returns only the rule name and the allowed
 * numbers.
 */
export async function getAthleteGapDetectionSources(
  organizationId: string,
  athleteId: string,
  status?: string,
): Promise<{ gap_id: string; detected_from: string | null }[]> {
  let sql = `
    select gap_id, detected_from
    from pilot.progression_gaps
    where organization_id = $1 and athlete_id = $2
  `;
  const params: unknown[] = [organizationId, athleteId];

  if (status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(status);
  }

  return query<{ gap_id: string; detected_from: string | null }>(sql, params);
}

export async function getProgressionGapById(
  organizationId: string,
  gapId: string,
): Promise<ProgressionGap | null> {
  return queryOne<ProgressionGap>(
    `select gap_id, athlete_id, gap_type, gap_description, severity, status, created_at
     from pilot.progression_gaps
     where organization_id = $1 and gap_id = $2`,
    [organizationId, gapId],
  );
}

export async function getAthleteAssignments(
  organizationId: string,
  athleteId: string,
  status?: string,
): Promise<DrillAssignment[]> {
  let sql = `
    select ${ASSIGNMENT_FIELDS}
    from pilot.drill_assignments a
    ${ASSIGNMENT_DRILL_JOIN}
    where a.organization_id = $1 and a.athlete_id = $2
  `;
  const params: unknown[] = [organizationId, athleteId];

  if (status) {
    sql += ` and a.status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ` order by a.due_date asc nulls last, a.created_at desc`;

  return query<DrillAssignment>(sql, params);
}

export async function getDrillAssignmentById(
  organizationId: string,
  assignmentId: string,
): Promise<DrillAssignment | null> {
  return queryOne<DrillAssignment>(
    `select ${ASSIGNMENT_FIELDS}
     from pilot.drill_assignments a
     ${ASSIGNMENT_DRILL_JOIN}
     where a.organization_id = $1 and a.assignment_id = $2`,
    [organizationId, assignmentId],
  );
}

export async function getAssignmentCompletions(
  organizationId: string,
  assignmentId: string,
): Promise<AssignmentCompletion[]> {
  return query<AssignmentCompletion>(
    `select completion_id, assignment_id, completed_at, reps_completed, notes, verification_status, verified_at
     from pilot.assignment_completions
     where organization_id = $1 and assignment_id = $2
     order by completed_at desc`,
    [organizationId, assignmentId],
  );
}
