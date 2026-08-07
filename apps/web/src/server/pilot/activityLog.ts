import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

// pilot.activity_log and pilot.sparring_rounds are owned by
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
// WHAT SPARRING EXPOSURE FUNCTIONS HERE DO NOT DO: compute a damage score, a
// cumulative risk index, or a recommended limit. getSparringExposureCounts
// below returns raw counts only, by design -- see the migration's own
// comment on pilot.sparring_rounds for why.

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

export type SparringType = 'hard' | 'play' | 'technical' | 'game' | 'conditioned';

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

export interface SparringRoundRow {
  organization_id: string;
  round_id: string;
  activity_id: string;
  athlete_id: string;
  round_number: number;
  duration_sec: number;
  sparring_type: SparringType;
  partner_athlete_id: string | null;
  headgear_worn: boolean | null;
  glove_oz: number | null;
  supervising_coach_account_id: string;
  stopped_early: boolean;
  stop_reason: string | null;
  coach_note: string;
  created_at: string;
}

const ACTIVITY_FIELDS =
  'organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type, '
  + 'occurred_on, started_at, duration_minutes, what_was_worked_on, class_id, attendance_status, '
  + 'capture_method, recorded_by_role, recorded_by_account_id, verified_by_account_id, verified_at, '
  + 'rpe, notes, created_at, updated_at';

const SPARRING_FIELDS =
  'organization_id, round_id, activity_id, athlete_id, round_number, duration_sec, sparring_type, '
  + 'partner_athlete_id, headgear_worn, glove_oz, supervising_coach_account_id, stopped_early, '
  + 'stop_reason, coach_note, created_at';

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
  } = {},
): Promise<ActivityLogRow[]> {
  return query<ActivityLogRow>(
    `select ${ACTIVITY_FIELDS}
     from pilot.activity_log
     where organization_id = $1
       and ($2::text is null or person_account_id = $2)
       and ($3::text is null or athlete_id = $3)
       and ($4::text is null or activity_domain = $4)
       and ($5::date is null or occurred_on >= $5)
       and ($6::date is null or occurred_on <= $6)
     order by occurred_on desc, created_at desc`,
    [
      organizationId,
      filter.personAccountId ?? null,
      filter.athleteId ?? null,
      filter.activityDomain ?? null,
      filter.since ?? null,
      filter.until ?? null,
    ],
  );
}

export interface RecordSparringRoundInput {
  athleteId: string;
  roundNumber: number;
  durationSec: number;
  sparringType: SparringType;
  partnerAthleteId?: string | null;
  headgearWorn?: boolean | null;
  gloveOz?: number | null;
  supervisingCoachAccountId: string;
  stoppedEarly?: boolean;
  stopReason?: string | null;
  coachNote?: string;
}

/**
 * All rounds for one activity occurrence, inserted together so a partial
 * write (three rounds in, the fourth rejected) never leaves an
 * undercounted exposure record on the table.
 */
export async function recordSparringRounds(
  organizationId: string,
  activityId: string,
  rounds: RecordSparringRoundInput[],
): Promise<SparringRoundRow[]> {
  if (rounds.length === 0) {
    return [];
  }

  try {
    return await withTransaction(async (client) => {
      const inserted: SparringRoundRow[] = [];
      for (const round of rounds) {
        const roundId = randomUUID();
        const result = await client.query<SparringRoundRow>(
          `insert into pilot.sparring_rounds
             (organization_id, round_id, activity_id, athlete_id, round_number, duration_sec, sparring_type,
              partner_athlete_id, headgear_worn, glove_oz, supervising_coach_account_id, stopped_early,
              stop_reason, coach_note)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           returning ${SPARRING_FIELDS}`,
          [
            organizationId,
            roundId,
            activityId,
            round.athleteId,
            round.roundNumber,
            round.durationSec,
            round.sparringType,
            round.partnerAthleteId ?? null,
            round.headgearWorn ?? null,
            round.gloveOz ?? null,
            round.supervisingCoachAccountId,
            round.stoppedEarly ?? false,
            round.stopReason ?? null,
            round.coachNote ?? '',
          ],
        );
        inserted.push(result.rows[0]);
      }
      return inserted;
    });
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'pilot_sparring_rounds_round_number_uq') {
      throw new Error('SPARRING_ROUND_NUMBER_DUPLICATE');
    }
    throw error;
  }
}

export async function listSparringRounds(
  organizationId: string,
  filter: { athleteId?: string; activityId?: string; since?: string; until?: string } = {},
): Promise<SparringRoundRow[]> {
  return query<SparringRoundRow>(
    `select ${SPARRING_FIELDS}
     from pilot.sparring_rounds
     where organization_id = $1
       and ($2::text is null or athlete_id = $2)
       and ($3::text is null or activity_id = $3)
       and ($4::timestamptz is null or created_at >= $4)
       and ($5::timestamptz is null or created_at <= $5)
     order by created_at desc, round_number asc`,
    [organizationId, filter.athleteId ?? null, filter.activityId ?? null, filter.since ?? null, filter.until ?? null],
  );
}

export interface SparringExposureCounts {
  total_rounds: number;
  total_duration_sec: number;
  rounds_by_type: Record<SparringType, number>;
}

/**
 * Raw counts only -- no score, no index, no limit. See this module's own
 * header and the migration's comment on pilot.sparring_rounds: no validated
 * safe sparring dose exists for any population this platform serves, so
 * nothing here may be read as a recommendation.
 */
export async function getSparringExposureCounts(
  organizationId: string,
  athleteId: string,
  since?: string,
): Promise<SparringExposureCounts> {
  const rounds = await listSparringRounds(organizationId, { athleteId, since });
  const roundsByType: Record<SparringType, number> = {
    hard: 0, play: 0, technical: 0, game: 0, conditioned: 0,
  };
  let totalDurationSec = 0;
  for (const round of rounds) {
    roundsByType[round.sparring_type] += 1;
    totalDurationSec += round.duration_sec;
  }
  return { total_rounds: rounds.length, total_duration_sec: totalDurationSec, rounds_by_type: roundsByType };
}
