import { query, queryOne, withTransaction } from './db';
import { ConflictError, ValidationError } from './errors';
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

// ---------------------------------------------------------------------------
// NEW-ASSIGNMENT IDENTITY -- W-D3, OD-2026-09-18-001.
//
// Every NEW assignment is anchored to an active operational drill in the
// assigning gym, and its wording is snapshotted FROM THAT DRILL. The caller
// supplies a drill_id and nothing that identifies the drill in words.
//
// Held at the writer, not only at the route, so no future caller can bypass it
// by forgetting a check: the writers below take `drillId: string` and resolve it
// themselves, in the same statement that inserts the row.
//
// WHAT IS DELIBERATELY NOT CHANGED. pilot.drill_assignments.drill_id stays
// NULLABLE and the free-text drill_name / drill_description columns stay
// exactly as they are. Every assignment written before drills had identity
// carries only that text, and the owner ruling keeps those rows valid, readable
// and unrewritten. The rule governs new writes, not history -- which is why it
// lives here and not in a NOT NULL constraint that would invalidate them.
// ---------------------------------------------------------------------------

/**
 * "An active operational drill in this gym", as a WHERE clause over
 * `pilot.drills d`. Each writer binds its own parameter positions.
 *
 * THE FIXTURE FIREWALL. The new-assignment writers read exactly five
 * pilot.drills columns -- drill_id, name, focus, difficulty, active -- and
 * never `DRILL_FIELDS` or `getDrill()`. Both of those select
 * `reference_drill_id`, which exists only once the drill-reference-provenance
 * migration has run. Several real-Postgres suites build pilot.drills without
 * that migration, and a writer that selected the column would fail every one of
 * them with `column "reference_drill_id" does not exist` -- exactly how W-D1's
 * CI went red. A write needs the name, the focus, the difficulty and whether the
 * drill is live; it never needs the drill's provenance.
 *
 * pilot.drill_library is not named anywhere here, and that is the whole of why
 * a reference-library id cannot be assigned: it is not a pilot.drills row, so
 * it selects nothing.
 */
export function assignableDrillPredicate(orgParam: string, drillParam: string): string {
  return `d.organization_id = ${orgParam} and d.drill_id = ${drillParam} and d.active`;
}

/**
 * Refuses anything but a non-empty string drill_id.
 *
 * The types already say `drillId: string`, but a type is a promise to the
 * compiler, not a check at runtime -- a JSON body, a script or a test can still
 * hand a writer null, a number or whitespace. This is the runtime half.
 */
export function requireAssignableDrillId(drillId: unknown): string {
  if (typeof drillId !== 'string' || !drillId.trim()) {
    throw new ValidationError(
      'A new assignment requires the drill_id of an active drill in this gym.',
      'DRILL_ID_REQUIRED',
    );
  }
  return drillId.trim();
}

/**
 * The drill_id named no ACTIVE drill in this gym at the moment of the write.
 *
 * Reached by a direct writer call with an unknown, cross-org, reference-library
 * or retired id, and by the one race the route's pre-check cannot close: a drill
 * retired between the route's check and the insert. A 400 rather than the
 * route's hidden 404, because by the time a request gets here the route has
 * already confirmed the drill exists in the caller's own gym.
 */
export function drillNotAssignable(): ValidationError {
  return new ValidationError(
    'That drill is not an active drill in this gym, so it cannot be assigned.',
    'DRILL_NOT_ASSIGNABLE',
  );
}

/**
 * Records a drill assignment against a gap.
 *
 * drillId is REQUIRED and must name an active operational drill in this
 * organization. drill_name and drill_description are snapshotted from that
 * drill's name and focus -- the caller cannot supply them -- and stay on the row
 * forever as the record of what was assigned that day, however the drill is
 * later edited. drillDifficulty is the one piece of drill wording a caller may
 * still set: an explicitly supplied difficulty overrides the drill's own, as it
 * always has, and otherwise the drill's difficulty is used.
 */
export async function assignDrill(params: {
  organizationId: string;
  gapId: string;
  athleteId: string;
  assignedByAccountId: string;
  drillId: string;
  drillDifficulty?: string;
  repCount?: number;
  durationMinutes?: number;
  frequencyPerWeek?: number;
  dueDate?: string;
}): Promise<DrillAssignment> {
  const drillId = requireAssignableDrillId(params.drillId);

  // Using crypto.randomUUID for secure randomness
  const assignmentId = `assignment_${Date.now()}_${randomUUID().substring(0, 8)}`;

  // One transaction: a drill assigned against a gap still marked 'identified'
  // keeps showing up as unaddressed work, so the pair must commit together or
  // not at all.
  return withTransaction(async (client) => {
    // RESOLVE AND SNAPSHOT IN ONE STATEMENT. The row is inserted FROM the drill,
    // so an unknown, cross-org, reference-library or retired drill_id selects
    // nothing and inserts nothing -- and because the check and the write are the
    // same statement, a drill cannot be retired in between. The snapshot cannot
    // diverge from the drill either: the wording comes from the row being
    // pointed at, not from anything the caller sent.
    //
    // The created row comes back through the same drill join every other read
    // uses, so the caller gets the display fields immediately.
    const result = await client.query<DrillAssignment>(
      `with a as (
        insert into pilot.drill_assignments (
          assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id,
          drill_name, drill_description, drill_difficulty, rep_count, duration_minutes,
          frequency_per_week, due_date, drill_id, status, completion_percentage
        )
        -- EXPLICIT CASTS. Unlike VALUES, a parameter in an INSERT ... SELECT
        -- list does not take its type from the target column: an untyped
        -- parameter there resolves to text, and text is not assignable to the
        -- integer and date columns below.
        select $1::text, d.organization_id, $4::text, $5::text, $6::text,
               d.name, d.focus, coalesce($7::text, d.difficulty),
               $8::integer, $9::integer, $10::integer, $11::date,
               d.drill_id, 'assigned', 0
        from pilot.drills d
        where ${assignableDrillPredicate('$2', '$3')}
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
        drillId,
        params.gapId,
        params.athleteId,
        params.assignedByAccountId,
        params.drillDifficulty || null,
        params.repCount || null,
        params.durationMinutes || null,
        params.frequencyPerWeek || null,
        params.dueDate || null,
      ],
    );

    // Nothing was inserted: the drill is not an active drill in this gym.
    // Thrown BEFORE the gap update, so the rollback leaves the gap untouched.
    if (result.rows.length === 0) {
      throw drillNotAssignable();
    }

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

/**
 * A new completion was sent for work a coach has cancelled.
 *
 * Owner decision 2026-09-22 (A-FIN-06): the athlete cannot log new
 * completions on cancelled work. A 409 rather than a 400: nothing is wrong
 * with the request itself -- the work it points at has been closed by
 * somebody else. The message is written for the athlete to read.
 */
export function completionOnCancelledWork(): ConflictError {
  return new ConflictError(
    'This work was cancelled, so a new completion cannot be logged against it. Completions already logged are kept.',
    'ASSIGNMENT_CANCELLED',
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
    // NO NEW LOGS ON CANCELLED WORK (A-FIN-06). The assignment row is locked
    // and read BEFORE the insert, inside this transaction, so a cancellation
    // cannot land between the check and the write: one that committed first
    // is seen here and refused, and one that arrives while this transaction
    // holds the row waits, then finds the work in whatever state this log
    // left it (cancelDrillAssignment's update is conditional on the status).
    //
    // The completions route refuses the same case first, from the read it
    // already makes, so its refusal is legible. This is what makes the rule
    // true for every caller and every interleaving -- the same split
    // assignDrill uses for drill identity.
    //
    // Only a NEW log is refused. Completions already logged against the work
    // are its history and are not read or touched here. A missing row is left
    // to the insert's foreign key, exactly as before this check existed.
    const locked = await client.query<{ status: string }>(
      `select status
       from pilot.drill_assignments
       where organization_id = $1 and assignment_id = $2
       for update`,
      [params.organizationId, params.assignmentId],
    );
    if (locked.rows[0]?.status === 'cancelled') {
      throw completionOnCancelledWork();
    }

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

// ---------------------------------------------------------------------------
// CANCELLING OPEN WORK -- A-FIN-06, owner decisions 2026-09-22.
//
// A coach (or organization admin) can take back work the athlete is still
// expected to do: 'assigned' or 'in_progress' becomes 'cancelled'. Completed
// and incomplete work is already closed and is refused. Cancel is the ONLY
// change this adds -- there is no edit, no delete and no reopen, here or
// anywhere else. The CHECK constraint on pilot.drill_assignments.status has
// allowed 'cancelled' since the progression migration; until now nothing
// wrote it.
//
// "KEEP HISTORY" IS THE STATEMENT, LITERALLY. The update sets status and
// nothing else. The dose (reps, duration, frequency), the due date, the drill
// anchor and the wording snapshotted from it, who assigned the work and when,
// completion_percentage and updated_at all stay exactly as they were, and
// pilot.assignment_completions is not named at all -- every log the athlete
// already made stays, verification state included. updated_at is left alone
// by instruction: no assignment writer sets it today (touchAssignmentProgress
// does not either), so a cancel that did would be the only thing moving it.
//
// "Open" is the same two statuses assignmentDrillInstruction.ts's isOpenWork
// names (OD-2026-09-19-002). Restated here rather than imported because that
// module imports this one.
// ---------------------------------------------------------------------------

/** The work is closed already, so there is nothing left to cancel. */
function assignmentClosed(status: 'completed' | 'incomplete'): ConflictError {
  return new ConflictError(
    status === 'completed'
      ? 'This work is already completed, so it cannot be cancelled.'
      : 'This work is already closed as incomplete, so it cannot be cancelled.',
    'ASSIGNMENT_CLOSED',
  );
}

export interface CancelDrillAssignmentResult {
  assignment: DrillAssignment;
  // True when the work was cancelled before this call and nothing was
  // written: a retry after a dropped response, or a second coach pressing the
  // same button. Both get the success they asked for, and the row as it is.
  alreadyCancelled: boolean;
}

/**
 * Cancels one open assignment inside one organization.
 *
 * Returns null when there is no such assignment for this athlete in this
 * organization -- unknown id, another gym's id, or an id belonging to a
 * different athlete all look the same, so the route can render every one of
 * them as hiddenNotFound(). Throws a 409 for completed or incomplete work.
 *
 * AUTHORIZATION IS THE CALLER'S. This decides only whether the work can move;
 * the route has already decided the actor may touch this athlete, from the
 * assignment's own athlete_id, before calling here.
 *
 * THE WRITE IS CONDITIONAL, NOT CHECK-THEN-WRITE. The status test is part of
 * the UPDATE, so a completion that closes the work concurrently cannot be
 * overwritten: Postgres re-evaluates the WHERE against the row a concurrent
 * writer committed, and completed work no longer matches. Only when nothing
 * matched does the row get re-read, to say WHY -- which is also what makes a
 * retry safe: already-cancelled work matches nothing, so nothing is written.
 */
export async function cancelDrillAssignment(params: {
  organizationId: string;
  assignmentId: string;
  athleteId: string;
}): Promise<CancelDrillAssignmentResult | null> {
  // The updated row comes back through the same drill join every other read
  // uses, so the caller gets exactly the shape the assignments list renders.
  // The RETURNING list mirrors assignDrill's, organization_id included for the
  // join.
  const cancelled = await query<DrillAssignment>(
    `with a as (
      update pilot.drill_assignments
      set status = 'cancelled'
      where organization_id = $1 and assignment_id = $2 and athlete_id = $3
        and status in ('assigned', 'in_progress')
      returning assignment_id, organization_id, gap_id, athlete_id, drill_id, drill_name,
               drill_description, drill_difficulty, rep_count, duration_minutes,
               frequency_per_week, due_date, status, completion_percentage,
               assigned_by_account_id, assigned_at, created_at
    )
    select ${ASSIGNMENT_FIELDS}
    from a
    ${ASSIGNMENT_DRILL_JOIN}`,
    [params.organizationId, params.assignmentId, params.athleteId],
  );
  if (cancelled.length > 0) {
    return { assignment: cancelled[0], alreadyCancelled: false };
  }

  // Nothing matched. Read the row as it stands to tell the outcomes apart.
  const current = await getDrillAssignmentById(params.organizationId, params.assignmentId);
  if (!current || current.athlete_id !== params.athleteId) {
    return null;
  }
  if (current.status === 'cancelled') {
    return { assignment: current, alreadyCancelled: true };
  }
  if (current.status === 'completed' || current.status === 'incomplete') {
    throw assignmentClosed(current.status);
  }

  // Open, yet the conditional update matched nothing. No writer moves work
  // from closed back to open, so this is not an outcome anyone can cause on
  // purpose. A plain Error, so the route answers with the generic 500 rather
  // than a message claiming to know what happened.
  throw new Error('Assignment was open on re-read after a cancel matched no row');
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
