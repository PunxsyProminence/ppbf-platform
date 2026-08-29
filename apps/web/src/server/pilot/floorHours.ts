import { randomUUID } from 'node:crypto';

import { BOARD_MINIMUM_COHORT_SIZE } from './boardSummary';
import { query, queryOne } from './db';

// pilot.activity_log_adjustments, pilot.v_activity_effective_minutes,
// pilot.v_floor_hours_public and pilot.v_floor_hours_admin are owned by
// infra/azure/pilot_slice_postgres_floor_hours_ledger_migration.sql,
// applied through the apply-migrations workflow like every other table.
// Nothing here issues DDL.
//
// CORRECTIONS ARE APPENDED, NEVER OVERWRITTEN. recordActivityAdjustment is
// the ONLY write this module performs -- there is no updateActivityLog or
// deleteActivityLog here. A mistyped duration is fixed by writing a new
// adjustment row that references the original, with a reason of at least
// 10 characters, matching pilot_activity_adj_reason.
//
// getFloorHoursPublic reads ONLY pilot.v_floor_hours_public, which the
// migration's own comment guarantees carries no person or athlete
// identifier. Do not add a per-person query to this module that a public
// page could accidentally call -- that is what getFloorHoursAdmin is for,
// and it is this module's only function that returns per-person figures.

const MIN_REASON_LENGTH = 10;

export interface ActivityLogAdjustmentRow {
  organization_id: string;
  adjustment_id: string;
  activity_id: string;
  delta_minutes: number;
  reason: string;
  adjusted_by_account_id: string;
  adjusted_by_role: string;
  adjusted_at: string;
}

export interface RecordActivityAdjustmentInput {
  organizationId: string;
  activityId: string;
  deltaMinutes: number;
  reason: string;
  adjustedByAccountId: string;
  adjustedByRole: string;
}

/**
 * Appends a correction. Refuses a reason under 10 characters up front,
 * matching pilot_activity_adj_reason -- "a correction without a stated
 * reason is indistinguishable from tampering" per the migration's own
 * comment.
 */
export async function recordActivityAdjustment(
  input: RecordActivityAdjustmentInput,
): Promise<ActivityLogAdjustmentRow> {
  if (input.deltaMinutes === 0) {
    throw new Error('ACTIVITY_ADJUSTMENT_DELTA_REQUIRED: delta_minutes must be nonzero');
  }
  if (input.reason.trim().length < MIN_REASON_LENGTH) {
    throw new Error(`ACTIVITY_ADJUSTMENT_REASON_TOO_SHORT: reason must be at least ${MIN_REASON_LENGTH} characters`);
  }

  const adjustmentId = randomUUID();
  const row = await queryOne<ActivityLogAdjustmentRow>(
    `insert into pilot.activity_log_adjustments
       (organization_id, adjustment_id, activity_id, delta_minutes, reason, adjusted_by_account_id, adjusted_by_role)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning organization_id, adjustment_id, activity_id, delta_minutes, reason, adjusted_by_account_id,
               adjusted_by_role, adjusted_at`,
    [
      input.organizationId,
      adjustmentId,
      input.activityId,
      input.deltaMinutes,
      input.reason.trim(),
      input.adjustedByAccountId,
      input.adjustedByRole,
    ],
  );
  if (!row) {
    throw new Error('Unable to record activity adjustment.');
  }
  return row;
}

export async function listActivityAdjustments(
  organizationId: string,
  activityId: string,
): Promise<ActivityLogAdjustmentRow[]> {
  return query<ActivityLogAdjustmentRow>(
    `select organization_id, adjustment_id, activity_id, delta_minutes, reason, adjusted_by_account_id,
            adjusted_by_role, adjusted_at
     from pilot.activity_log_adjustments
     where organization_id = $1 and activity_id = $2
     order by adjusted_at asc`,
    [organizationId, activityId],
  );
}

export type FloorHoursPeriodKind = 'all_time' | 'year' | 'quarter';

/** Whether a public row's participant count cleared the k-anonymity floor. */
export type FloorHoursParticipantStatus = 'available' | 'insufficient_data';

export interface FloorHoursPublicRow {
  organization_id: string;
  activity_domain: string;
  period_kind: FloorHoursPeriodKind;
  period_year: number | null;
  period_quarter: number | null;
  hours: string;
  sessions_recorded: string;
  /** Null whenever participant_status is 'insufficient_data'. Never 0 for a
   * suppressed cohort -- a withheld figure and a measured zero are different
   * facts and stay distinguishable all the way to the caller. */
  distinct_participants: string | null;
  participant_status: FloorHoursParticipantStatus;
  first_recorded: string | null;
  last_recorded: string | null;
}

/**
 * Organization totals only -- see this module's own header. Safe to read
 * from a public route.
 */
export async function getFloorHoursPublic(
  organizationId: string,
  filter: { activityDomain?: string; periodKind?: FloorHoursPeriodKind } = {},
): Promise<FloorHoursPublicRow[]> {
  const rows = await query<Omit<FloorHoursPublicRow, 'participant_status'>>(
    `select organization_id, activity_domain, period_kind, period_year, period_quarter, hours,
            sessions_recorded, distinct_participants, first_recorded, last_recorded
     from pilot.v_floor_hours_public
     where organization_id = $1
       and ($2::text is null or activity_domain = $2)
       and ($3::text is null or period_kind = $3)
     order by activity_domain, period_kind, period_year desc nulls last, period_quarter desc nulls last`,
    [organizationId, filter.activityDomain ?? null, filter.periodKind ?? null],
  );

  /* K-ANONYMITY ON THE UNAUTHENTICATED SURFACE.
   *
   * This is the only floor-hours reader with no session behind it, and until
   * now it was the LEAST protected: pilot.v_floor_hours_public exposed
   * distinct_participants with no floor at all, while board members -- who are
   * authenticated, hold a governance role, and see the same class of figure --
   * get everything below BOARD_MINIMUM_COHORT_SIZE withheld by
   * boardSummary.ts. A public page being more revealing than the governance
   * one is backwards, so the same floor applies here.
   *
   * "1 participant, 2.5 hours, first and last recorded on these dates" is a
   * re-identification vector in a gym this size. The participant COUNT is the
   * part that carries it, so the count is what is withheld.
   *
   * HOURS AND SESSIONS ARE DELIBERATELY NOT SUPPRESSED. They are organization
   * totals over activity rows, not over people, and they are the entire point
   * of a public floor-hours page. Withholding them would cost the surface its
   * purpose without closing the vector the count opens.
   *
   * RESIDUAL, STATED HONESTLY RATHER THAN PAPERED OVER: a very small hours
   * figure still narrows the cohort by inference, and the first/last dates
   * still bound when activity happened. This closes the direct disclosure, not
   * every inference from it. Tightening further is a product decision about
   * what a public page is for, not something to smuggle in here.
   *
   * The floor is IMPORTED rather than restated. boardSummary.ts exports it
   * with the note that other aggregates should hold "this same floor rather
   * than inventing a second, weaker one" -- a public surface inventing its own
   * number is exactly that failure. */
  return rows.map((row) => {
    const participants = Number(row.distinct_participants);
    const cleared = Number.isFinite(participants) && participants >= BOARD_MINIMUM_COHORT_SIZE;
    return {
      ...row,
      distinct_participants: cleared ? row.distinct_participants : null,
      participant_status: cleared ? 'available' : 'insufficient_data',
    } satisfies FloorHoursPublicRow;
  });
}

export interface FloorHoursAdminRow {
  organization_id: string;
  person_account_id: string;
  athlete_id: string | null;
  activity_domain: string;
  period_year: number;
  period_quarter: number;
  hours: string;
  recorded_minutes: string;
  adjustment_minutes: string;
  sessions_recorded: string;
  first_recorded: string;
  last_recorded: string;
}

/**
 * Per-person detail, including the adjustment trail. Gate this behind
 * admin authorization at the route -- the view itself carries no access
 * control.
 */
export async function getFloorHoursAdmin(
  organizationId: string,
  filter: { personAccountId?: string; athleteId?: string; activityDomain?: string } = {},
): Promise<FloorHoursAdminRow[]> {
  return query<FloorHoursAdminRow>(
    `select organization_id, person_account_id, athlete_id, activity_domain, period_year, period_quarter,
            hours, recorded_minutes, adjustment_minutes, sessions_recorded, first_recorded, last_recorded
     from pilot.v_floor_hours_admin
     where organization_id = $1
       and ($2::text is null or person_account_id = $2)
       and ($3::text is null or athlete_id = $3)
       and ($4::text is null or activity_domain = $4)
     order by person_account_id, activity_domain, period_year desc, period_quarter desc`,
    [organizationId, filter.personAccountId ?? null, filter.athleteId ?? null, filter.activityDomain ?? null],
  );
}
