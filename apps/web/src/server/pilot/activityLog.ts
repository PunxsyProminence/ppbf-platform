import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.activity_log is owned by
// infra/azure/pilot_slice_postgres_activity_log_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// SUPERSEDES pilot.attendance AND pilot.scheduler_attendance IN INTENT ONLY.
// This module never reads or writes either table -- the migration's own
// header is explicit that a human decides which source wins on conflict
// before any backfill runs, and that decision belongs to a separate,
// reviewable backfill script, not this module.
//
// Sparring exposure lives in sparringExposure.ts (pilot.sparring_exposure),
// not here -- see that module's header for why round count was replaced by
// time_under_impact_sec before either ever shipped to a database.

export type ActivityDomain =
  | 'boxing_training'
  | 'schoolwork'
  | 'gym_service'
  | 'community_service'
  | 'work_study'
  | 'other';

export type ActivityCaptureMethod =
  | 'door_terminal'
  | 'self'
  | 'coach_override'
  | 'admin_override'
  | 'supervisor_entry'
  | 'import';

// The two domains pilot_activity_log_verified_check requires a named human
// verifier on, because they are reported to an external authority. Kept as
// one exported list so the pre-insert check here and the constraint it
// mirrors can never silently drift apart.
export const VERIFIER_REQUIRED_DOMAINS: ReadonlySet<ActivityDomain> = new Set(['community_service', 'work_study']);

export interface ActivityLogRow {
  organization_id: string;
  activity_id: string;
  person_account_id: string;
  athlete_id: string | null;
  activity_domain: ActivityDomain;
  activity_type: string;
  occurred_on: string;
  started_at: string | null;
  duration_minutes: number;
  what_was_worked_on: string;
  class_id: string | null;
  attendance_status: 'present' | 'absent' | 'excused';
  capture_method: ActivityCaptureMethod;
  recorded_by_role: string;
  recorded_by_account_id: string;
  verified_by_account_id: string | null;
  verified_at: string | null;
  rpe: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

const ACTIVITY_FIELDS =
  'organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type, '
  + 'occurred_on, started_at, duration_minutes, what_was_worked_on, class_id, attendance_status, '
  + 'capture_method, recorded_by_role, recorded_by_account_id, verified_by_account_id, verified_at, '
  + 'rpe, notes, created_at, updated_at';

export interface RecordActivityInput {
  organizationId: string;
  personAccountId: string;
  athleteId?: string | null;
  activityDomain: ActivityDomain;
  activityType: string;
  occurredOn: string;
  startedAt?: string | null;
  durationMinutes: number;
  whatWasWorkedOn?: string;
  classId?: string | null;
  attendanceStatus?: 'present' | 'absent' | 'excused';
  captureMethod: ActivityCaptureMethod;
  recordedByRole: string;
  recordedByAccountId: string;
  verifiedByAccountId?: string | null;
  rpe?: number | null;
  notes?: string;
}

/**
 * A single occurrence: one person, one domain, one day (plus class/start-time
 * where those apply). Checked here, ahead of the insert, purely so a
 * duplicate reads as a clear domain error rather than a raw constraint
 * violation -- pilot_activity_log_one_per_occurrence is still the real
 * enforcement, including under concurrency.
 */
export async function recordActivity(input: RecordActivityInput): Promise<ActivityLogRow> {
  if (VERIFIER_REQUIRED_DOMAINS.has(input.activityDomain) && !input.verifiedByAccountId) {
    throw new Error(
      `ACTIVITY_LOG_VERIFIER_REQUIRED: ${input.activityDomain} rows require a named human verifier`,
    );
  }

  const activityId = randomUUID();

  try {
    const row = await queryOne<ActivityLogRow>(
      `insert into pilot.activity_log
         (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
          occurred_on, started_at, duration_minutes, what_was_worked_on, class_id, attendance_status,
          capture_method, recorded_by_role, recorded_by_account_id, verified_by_account_id, verified_at,
          rpe, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               case when $16::text is null then null else now() end,$17,$18)
       returning ${ACTIVITY_FIELDS}`,
      [
        input.organizationId,
        activityId,
        input.personAccountId,
        input.athleteId ?? null,
        input.activityDomain,
        input.activityType,
        input.occurredOn,
        input.startedAt ?? null,
        input.durationMinutes,
        input.whatWasWorkedOn ?? '',
        input.classId ?? null,
        input.attendanceStatus ?? 'present',
        input.captureMethod,
        input.recordedByRole,
        input.recordedByAccountId,
        input.verifiedByAccountId ?? null,
        input.rpe ?? null,
        input.notes ?? '',
      ],
    );
    if (!row) {
      throw new Error('Unable to record activity.');
    }
    return row;
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'pilot_activity_log_one_per_occurrence') {
      throw new Error('ACTIVITY_LOG_DUPLICATE_OCCURRENCE');
    }
    throw error;
  }
}

export async function listActivityLog(
  organizationId: string,
  filter: {
    personAccountId?: string;
    athleteId?: string;
    activityDomain?: ActivityDomain;
    since?: string;
    until?: string;
    limit?: number;
  } = {},
): Promise<ActivityLogRow[]> {
  // limit is opt-in and defaults to unbounded. getCommunityServiceTotals
  // (communityService.ts) sums these rows into a figure this module's own
  // header says may go to a school, a court, or a scholarship committee --
  // a default cap here would silently under-report someone's hours rather
  // than just running slower, which is a worse failure than the unbounded
  // growth it would guard against. A caller that genuinely wants a bounded
  // page (as opposed to a complete total) opts in explicitly.
  return query<ActivityLogRow>(
    `select ${ACTIVITY_FIELDS}
     from pilot.activity_log
     where organization_id = $1
       and ($2::text is null or person_account_id = $2)
       and ($3::text is null or athlete_id = $3)
       and ($4::text is null or activity_domain = $4)
       and ($5::date is null or occurred_on >= $5)
       and ($6::date is null or occurred_on <= $6)
     order by occurred_on desc, created_at desc
     ${filter.limit ? 'limit $7' : ''}`,
    [
      organizationId,
      filter.personAccountId ?? null,
      filter.athleteId ?? null,
      filter.activityDomain ?? null,
      filter.since ?? null,
      filter.until ?? null,
      ...(filter.limit ? [filter.limit] : []),
    ],
  );
}

