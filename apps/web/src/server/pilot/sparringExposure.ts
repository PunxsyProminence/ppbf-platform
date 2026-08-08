import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.sparring_exposure and pilot.session_load are owned by
// infra/azure/pilot_slice_postgres_sparring_exposure_and_load_migration.sql,
// applied through the apply-migrations workflow like every other table.
// Nothing here issues DDL.
//
// WHAT THIS MODULE REFUSES TO DO, MATCHING THE MIGRATION'S OWN HEADER: no
// damage score, no cumulative risk index, no recommended limit, no
// clearance. getSparringExposureCounts returns raw counts and a raw sum of
// seconds -- nothing here computes or displays a derived risk figure.
//
// SESSION LOAD IS NEVER MERGED. rpe_physical and rpe_cognitive stay two
// separate numbers through this whole module. Derived load (sRPE x
// duration) is computed only where explicitly asked for
// (deriveUnvalidatedSessionLoad), is never stored, and is always labelled
// unvalidated -- see the migration header for why.

export type SparringType = 'hard' | 'play' | 'technical' | 'game' | 'conditioned';
export type CoachObservedIntensity = 'light' | 'moderate' | 'firm' | 'unclear';
export type CoachObservedHeadContact = 'none' | 'incidental' | 'regular' | 'frequent' | 'unclear';
export type AthletePresentation = 'normal' | 'slowed' | 'unsteady' | 'withdrawn' | 'other_concern';
export type SessionLoadRatedBy = 'athlete' | 'coach_proxy';
export type NextSessionQuality = 'better' | 'same' | 'slightly_down' | 'clearly_down' | 'not_assessed';

export interface SparringExposureRow {
  organization_id: string;
  exposure_id: string;
  activity_id: string;
  athlete_id: string;
  segment_number: number;
  sparring_type: SparringType;
  time_under_impact_sec: number;
  round_equivalent: string | null;
  partner_athlete_id: string | null;
  headgear_worn: boolean | null;
  glove_oz: number | null;
  coach_observed_intensity: CoachObservedIntensity;
  coach_observed_head_contact: CoachObservedHeadContact;
  athlete_presentation: AthletePresentation | null;
  coach_note: string;
  supervising_coach_account_id: string;
  stopped_early: boolean;
  stop_rule_id: string | null;
  stop_reason: string | null;
  device_type: string | null;
  device_event_count: number | null;
  device_note: string | null;
  created_at: string;
}

export interface SessionLoadRow {
  organization_id: string;
  load_id: string;
  activity_id: string;
  athlete_id: string;
  rpe_physical: string | null;
  rpe_cognitive: string | null;
  rpe_scale: string;
  rated_by: SessionLoadRatedBy;
  rated_at: string;
  minutes_at_rating: number | null;
  next_session_quality: NextSessionQuality | null;
  next_session_activity_id: string | null;
  note: string;
  created_at: string;
}

const EXPOSURE_FIELDS =
  'organization_id, exposure_id, activity_id, athlete_id, segment_number, sparring_type, '
  + 'time_under_impact_sec, round_equivalent, partner_athlete_id, headgear_worn, glove_oz, '
  + 'coach_observed_intensity, coach_observed_head_contact, athlete_presentation, coach_note, '
  + 'supervising_coach_account_id, stopped_early, stop_rule_id, stop_reason, device_type, '
  + 'device_event_count, device_note, created_at';

const LOAD_FIELDS =
  'organization_id, load_id, activity_id, athlete_id, rpe_physical, rpe_cognitive, rpe_scale, '
  + 'rated_by, rated_at, minutes_at_rating, next_session_quality, next_session_activity_id, note, created_at';

export interface RecordSparringExposureInput {
  organizationId: string;
  activityId: string;
  athleteId: string;
  segmentNumber: number;
  sparringType: SparringType;
  timeUnderImpactSec: number;
  roundEquivalent?: number | null;
  partnerAthleteId?: string | null;
  headgearWorn?: boolean | null;
  gloveOz?: number | null;
  coachObservedIntensity: CoachObservedIntensity;
  coachObservedHeadContact: CoachObservedHeadContact;
  athletePresentation?: AthletePresentation | null;
  coachNote?: string;
  supervisingCoachAccountId: string;
  stoppedEarly?: boolean;
  stopRuleId?: string | null;
  stopReason?: string | null;
  deviceType?: string | null;
  deviceEventCount?: number | null;
  deviceNote?: string | null;
}

/**
 * One segment (round, exchange, or coach-defined unit) of sparring
 * exposure. stopped_early without a stop_reason is rejected by
 * pilot_sparring_exposure_stop -- silence is not a record.
 */
export async function recordSparringExposure(input: RecordSparringExposureInput): Promise<SparringExposureRow> {
  const exposureId = randomUUID();

  try {
    const row = await queryOne<SparringExposureRow>(
      `insert into pilot.sparring_exposure
         (organization_id, exposure_id, activity_id, athlete_id, segment_number, sparring_type,
          time_under_impact_sec, round_equivalent, partner_athlete_id, headgear_worn, glove_oz,
          coach_observed_intensity, coach_observed_head_contact, athlete_presentation, coach_note,
          supervising_coach_account_id, stopped_early, stop_rule_id, stop_reason, device_type,
          device_event_count, device_note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       returning ${EXPOSURE_FIELDS}`,
      [
        input.organizationId,
        exposureId,
        input.activityId,
        input.athleteId,
        input.segmentNumber,
        input.sparringType,
        input.timeUnderImpactSec,
        input.roundEquivalent ?? null,
        input.partnerAthleteId ?? null,
        input.headgearWorn ?? null,
        input.gloveOz ?? null,
        input.coachObservedIntensity,
        input.coachObservedHeadContact,
        input.athletePresentation ?? null,
        input.coachNote ?? '',
        input.supervisingCoachAccountId,
        input.stoppedEarly ?? false,
        input.stopRuleId ?? null,
        input.stopReason ?? null,
        input.deviceType ?? null,
        input.deviceEventCount ?? null,
        input.deviceNote ?? null,
      ],
    );
    if (!row) {
      throw new Error('Unable to record sparring exposure.');
    }
    return row;
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'pilot_sparring_exposure_segment_uq') {
      throw new Error('SPARRING_EXPOSURE_SEGMENT_DUPLICATE');
    }
    if (code === '23514' && constraint === 'pilot_sparring_exposure_stop') {
      throw new Error('SPARRING_EXPOSURE_STOP_REASON_REQUIRED');
    }
    throw error;
  }
}

export async function listSparringExposure(
  organizationId: string,
  filter: { athleteId?: string; activityId?: string; since?: string; until?: string } = {},
): Promise<SparringExposureRow[]> {
  return query<SparringExposureRow>(
    `select ${EXPOSURE_FIELDS}
     from pilot.sparring_exposure
     where organization_id = $1
       and ($2::text is null or athlete_id = $2)
       and ($3::text is null or activity_id = $3)
       and ($4::timestamptz is null or created_at >= $4)
       and ($5::timestamptz is null or created_at <= $5)
     order by created_at desc, segment_number asc`,
    [organizationId, filter.athleteId ?? null, filter.activityId ?? null, filter.since ?? null, filter.until ?? null],
  );
}

export interface SparringExposureCounts {
  total_segments: number;
  total_time_under_impact_sec: number;
  segments_by_type: Record<SparringType, number>;
}

/**
 * Raw counts and a raw sum of seconds only -- no score, no index, no
 * limit. See this module's own header and the migration's comment on
 * pilot.sparring_exposure: no validated safe sparring dose exists for any
 * population this platform serves, so nothing here may be read as a
 * recommendation.
 */
export async function getSparringExposureCounts(
  organizationId: string,
  athleteId: string,
  since?: string,
): Promise<SparringExposureCounts> {
  const segments = await listSparringExposure(organizationId, { athleteId, since });
  const segmentsByType: Record<SparringType, number> = {
    hard: 0, play: 0, technical: 0, game: 0, conditioned: 0,
  };
  let totalTimeUnderImpactSec = 0;
  for (const segment of segments) {
    segmentsByType[segment.sparring_type] += 1;
    totalTimeUnderImpactSec += segment.time_under_impact_sec;
  }
  return {
    total_segments: segments.length,
    total_time_under_impact_sec: totalTimeUnderImpactSec,
    segments_by_type: segmentsByType,
  };
}

export interface RecordSessionLoadInput {
  organizationId: string;
  activityId: string;
  athleteId: string;
  rpePhysical?: number | null;
  rpeCognitive?: number | null;
  rpeScale?: string;
  ratedBy: SessionLoadRatedBy;
  minutesAtRating?: number | null;
  nextSessionQuality?: NextSessionQuality | null;
  nextSessionActivityId?: string | null;
  note?: string;
}

/**
 * One rating of one session by one rater. Both the athlete and a
 * coach_proxy can independently rate the same activity -- the unique
 * constraint is (organization_id, activity_id, athlete_id, rated_by), not
 * a bare (activity_id, athlete_id).
 */
export async function recordSessionLoad(input: RecordSessionLoadInput): Promise<SessionLoadRow> {
  const loadId = randomUUID();

  try {
    const row = await queryOne<SessionLoadRow>(
      `insert into pilot.session_load
         (organization_id, load_id, activity_id, athlete_id, rpe_physical, rpe_cognitive, rpe_scale,
          rated_by, minutes_at_rating, next_session_quality, next_session_activity_id, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning ${LOAD_FIELDS}`,
      [
        input.organizationId,
        loadId,
        input.activityId,
        input.athleteId,
        input.rpePhysical ?? null,
        input.rpeCognitive ?? null,
        input.rpeScale ?? 'CR10',
        input.ratedBy,
        input.minutesAtRating ?? null,
        input.nextSessionQuality ?? null,
        input.nextSessionActivityId ?? null,
        input.note ?? '',
      ],
    );
    if (!row) {
      throw new Error('Unable to record session load.');
    }
    return row;
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'pilot_session_load_rated_by_uq') {
      throw new Error('SESSION_LOAD_ALREADY_RATED');
    }
    throw error;
  }
}

export async function listSessionLoad(
  organizationId: string,
  filter: { athleteId?: string; activityId?: string; ratedBy?: SessionLoadRatedBy } = {},
): Promise<SessionLoadRow[]> {
  return query<SessionLoadRow>(
    `select ${LOAD_FIELDS}
     from pilot.session_load
     where organization_id = $1
       and ($2::text is null or athlete_id = $2)
       and ($3::text is null or activity_id = $3)
       and ($4::text is null or rated_by = $4)
     order by rated_at desc`,
    [organizationId, filter.athleteId ?? null, filter.activityId ?? null, filter.ratedBy ?? null],
  );
}

/**
 * sRPE x duration, computed on demand and never stored -- the migration's
 * own header explains why: boxing sRPE has never been validated, and a
 * stored column would freeze an unvalidated formula and invite it being
 * read as calibrated. Returns null when either rating is missing rather
 * than guessing. Every caller MUST label this "unvalidated" wherever it is
 * displayed -- that label is this function's whole reason to exist as a
 * function instead of a raw multiplication inline.
 */
export function deriveUnvalidatedSessionLoad(
  row: Pick<SessionLoadRow, 'rpe_physical' | 'minutes_at_rating'>,
  fallbackDurationMinutes: number,
): { unvalidated_physical_load: number | null } {
  if (row.rpe_physical === null) {
    return { unvalidated_physical_load: null };
  }
  const minutes = row.minutes_at_rating ?? fallbackDurationMinutes;
  return { unvalidated_physical_load: Number(row.rpe_physical) * minutes };
}
