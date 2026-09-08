import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// The training-attempts ledger (owner decision 2026-08-16): one row per
// attempt, failure-first. "Every failure -- failed reps, failed time,
// failed distance": the failed attempt is the most informative row, because
// the edge where an athlete fails IS their current capacity.
//
// made/failed is COMPUTED here from target + direction, never supplied by
// the caller: reps/distance/load/rounds/holds are at_least targets, times
// are at_most. An attempt with no target is a measurement -- it carries no
// verdict, and the schema refuses one.
//
// Safeguarding boundary: rows carry the athlete LINK only. Access rides the
// standing athlete-access checks (staff plus the athlete's own records).
// NO leaderboard, ranking, or cross-athlete comparison may be built on this
// module -- failure data describes training, never the child.
//
// BASE-06: a coach may CONFIRM, CORRECT or DISPUTE an attempt. A review is an
// additive row in pilot.training_attempt_reviews; the source attempt below is
// never rewritten. Reads come from pilot.v_training_attempts_effective, which
// carries the source fields AND the current review's effective interpretation
// (corrected values when corrected; NULL verdict when disputed). The corrected
// verdict is computed HERE by the same computeMade the source uses -- the
// client never supplies a verdict, for a record or for a correction.

export type AttemptMetricKind = 'reps' | 'time_seconds' | 'distance_m' | 'load_kg' | 'rounds' | 'hold_seconds';
export type AttemptDirection = 'at_least' | 'at_most';
export type AttemptContextType =
  | 'session' | 'drill_assignment' | 'assessment' | 'film_study' | 'open_floor'
  | 'technical_sparring' | 'sparring_games' | 'sparring_drills' | 'open_sparring';
export type AttemptReviewState = 'confirmed' | 'corrected' | 'disputed';

export const ATTEMPT_METRIC_KINDS: readonly AttemptMetricKind[] = [
  'reps', 'time_seconds', 'distance_m', 'load_kg', 'rounds', 'hold_seconds',
];

export const ATTEMPT_REVIEW_STATES: readonly AttemptReviewState[] = ['confirmed', 'corrected', 'disputed'];

// Sparring contexts are first-class (owner decision 2026-08-16): where an
// attempt fails matters as much as that it failed. A defense that holds in
// sparring drills and breaks in open sparring is a transfer fact.
export const ATTEMPT_CONTEXT_TYPES: readonly AttemptContextType[] = [
  'session', 'drill_assignment', 'assessment', 'film_study', 'open_floor',
  'technical_sparring', 'sparring_games', 'sparring_drills', 'open_sparring',
];

// A correction or a dispute must say why (mirrors the database's own
// pilot_attempt_reviews_reason_required constraint, so the service refuses
// before the row is ever sent). A confirmation needs no reason.
export const MIN_REVIEW_REASON_LENGTH = 10;

/** Times are better lower; everything else is better higher. The default
 * direction per metric -- callers may override for unusual protocols (e.g.
 * a pacing drill where slower is the target). */
export const DEFAULT_DIRECTION: Record<AttemptMetricKind, AttemptDirection> = {
  reps: 'at_least',
  time_seconds: 'at_most',
  distance_m: 'at_least',
  load_kg: 'at_least',
  rounds: 'at_least',
  hold_seconds: 'at_least',
};

export interface TrainingAttemptRow {
  organization_id: string;
  attempt_id: string;
  athlete_id: string;
  athlete_name: string;
  context_type: AttemptContextType;
  context_id: string | null;
  metric_kind: AttemptMetricKind;
  direction: AttemptDirection;
  target_value: string | null;
  achieved_value: string;
  made: boolean | null;
  note: string;
  attempted_at: string;
  // Who recorded the source attempt, as a role -- never the account id -- so a
  // surface can say "recorded by athlete" vs "by coach".
  recorded_by_role: string | null;
  // The CURRENT coach review (newest), null when the attempt is unreviewed.
  current_review_id: string | null;
  review_state: AttemptReviewState | null;
  corrected_target_value: string | null;
  corrected_achieved_value: string | null;
  corrected_made: boolean | null;
  review_reason: string | null;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  // The one interpretation downstream reads: source unless corrected; NULL
  // (abstention) while the current disposition is disputed.
  effective_target_value: string | null;
  effective_achieved_value: string | null;
  effective_made: boolean | null;
}

export interface AttemptReviewRow {
  organization_id: string;
  review_id: string;
  attempt_id: string;
  review_state: AttemptReviewState;
  corrected_target_value: string | null;
  corrected_achieved_value: string | null;
  corrected_made: boolean | null;
  reason: string;
  reviewed_by_account_id: string;
  reviewed_at: string;
}

// Reads come from the effective view, which already joins the athlete, the
// recorder's role and the current review, and computes the effective values.
const FIELDS = `v.organization_id, v.attempt_id, v.athlete_id, v.athlete_name,
  v.context_type, v.context_id, v.metric_kind, v.direction,
  v.target_value::text as target_value, v.achieved_value::text as achieved_value,
  v.made, v.note, v.attempted_at, v.recorded_by_role,
  v.current_review_id, v.review_state,
  v.corrected_target_value::text as corrected_target_value,
  v.corrected_achieved_value::text as corrected_achieved_value,
  v.corrected_made, v.review_reason, v.reviewed_by_account_id, v.reviewed_at,
  v.effective_target_value::text as effective_target_value,
  v.effective_achieved_value::text as effective_achieved_value,
  v.effective_made`;

const FROM = `from pilot.v_training_attempts_effective v`;

export function isAttemptMetricKind(value: unknown): value is AttemptMetricKind {
  return typeof value === 'string' && (ATTEMPT_METRIC_KINDS as readonly string[]).includes(value);
}

export function isAttemptContextType(value: unknown): value is AttemptContextType {
  return typeof value === 'string' && (ATTEMPT_CONTEXT_TYPES as readonly string[]).includes(value);
}

export function isAttemptReviewState(value: unknown): value is AttemptReviewState {
  return typeof value === 'string' && (ATTEMPT_REVIEW_STATES as readonly string[]).includes(value);
}

/** The verdict, from the two stored facts. Exported so tests pin the
 * directionality: a 92s attempt at a 90s at_most target is a MISS. */
export function computeMade(
  targetValue: number | null,
  achievedValue: number,
  direction: AttemptDirection,
): boolean | null {
  if (targetValue === null) return null;
  return direction === 'at_least' ? achievedValue >= targetValue : achievedValue <= targetValue;
}

export async function recordAttempt(input: {
  organizationId: string;
  athleteId: string;
  contextType?: AttemptContextType;
  contextId?: string | null;
  metricKind: AttemptMetricKind;
  direction?: AttemptDirection;
  targetValue: number | null;
  achievedValue: number;
  note?: string;
  recordedByAccountId: string;
}): Promise<TrainingAttemptRow | null> {
  // The athlete lookup doubles as the tenancy check: an id from another
  // organization reads as "no such athlete" and the caller answers with a
  // hidden not-found.
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const direction = input.direction ?? DEFAULT_DIRECTION[input.metricKind];
  const made = computeMade(input.targetValue, input.achievedValue, direction);
  const attemptId = randomUUID();

  await queryOne(
    `insert into pilot.training_attempts
       (organization_id, attempt_id, athlete_id, context_type, context_id,
        metric_kind, direction, target_value, achieved_value, made, note, recorded_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning attempt_id`,
    [
      input.organizationId,
      attemptId,
      input.athleteId,
      input.contextType ?? 'open_floor',
      input.contextId ?? null,
      input.metricKind,
      direction,
      input.targetValue,
      input.achievedValue,
      made,
      input.note ?? '',
      input.recordedByAccountId,
    ],
  );

  return queryOne<TrainingAttemptRow>(
    `select ${FIELDS} ${FROM}
     where v.organization_id = $1 and v.attempt_id = $2`,
    [input.organizationId, attemptId],
  );
}

/** Newest first for one athlete, optionally one metric. */
export async function listAttempts(
  organizationId: string,
  athleteId: string,
  filter: { metricKind?: AttemptMetricKind; limit?: number } = {},
): Promise<TrainingAttemptRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  return query<TrainingAttemptRow>(
    `select ${FIELDS} ${FROM}
     where v.organization_id = $1 and v.athlete_id = $2
       and ($3::text is null or v.metric_kind = $3)
     order by v.attempted_at desc
     limit ${limit}`,
    [organizationId, athleteId, filter.metricKind ?? null],
  );
}

/** The source attempt's own facts a review needs: which athlete it belongs to
 * (for the caller's access check) and its stored direction (for the corrected
 * verdict). Org-scoped, so an attempt in another organization reads as null --
 * a hidden not-found, never an existence leak. */
export async function getAttemptForReview(
  organizationId: string,
  attemptId: string,
): Promise<{ athlete_id: string; direction: AttemptDirection } | null> {
  return queryOne<{ athlete_id: string; direction: AttemptDirection }>(
    `select athlete_id, direction from pilot.training_attempts
     where organization_id = $1 and attempt_id = $2`,
    [organizationId, attemptId],
  );
}

/**
 * Record one coach review of an existing attempt. Additive: this INSERTs a new
 * pilot.training_attempt_reviews row and never touches the source attempt. The
 * corrected verdict is computed here from the corrected values and the
 * attempt's OWN stored direction -- the caller does not supply it. Returns null
 * when the attempt does not exist in this organization (hidden not-found).
 */
export async function recordReview(input: {
  organizationId: string;
  attemptId: string;
  reviewState: AttemptReviewState;
  correctedTargetValue?: number | null;
  correctedAchievedValue?: number | null;
  reason?: string;
  reviewedByAccountId: string;
}): Promise<AttemptReviewRow | null> {
  const attempt = await getAttemptForReview(input.organizationId, input.attemptId);
  if (!attempt) return null;

  let correctedTarget: number | null = null;
  let correctedAchieved: number | null = null;
  let correctedMade: boolean | null = null;

  if (input.reviewState === 'corrected') {
    // A corrected review states what actually happened; the verdict is ours.
    correctedTarget = input.correctedTargetValue ?? null;
    correctedAchieved = input.correctedAchievedValue ?? null;
    if (correctedAchieved === null) {
      throw new Error('A corrected review needs the achieved value.');
    }
    correctedMade = computeMade(correctedTarget, correctedAchieved, attempt.direction);
  }

  const reason = (input.reason ?? '').trim();
  if (input.reviewState !== 'confirmed' && reason.length < MIN_REVIEW_REASON_LENGTH) {
    throw new Error(`A ${input.reviewState} review needs a reason of at least ${MIN_REVIEW_REASON_LENGTH} characters.`);
  }

  const reviewId = randomUUID();
  await queryOne(
    `insert into pilot.training_attempt_reviews
       (organization_id, review_id, attempt_id, review_state,
        corrected_target_value, corrected_achieved_value, corrected_made,
        reason, reviewed_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning review_id`,
    [
      input.organizationId,
      reviewId,
      input.attemptId,
      input.reviewState,
      correctedTarget,
      correctedAchieved,
      correctedMade,
      input.reviewState === 'confirmed' ? '' : reason,
      input.reviewedByAccountId,
    ],
  );

  return queryOne<AttemptReviewRow>(
    `select organization_id, review_id, attempt_id, review_state,
       corrected_target_value::text as corrected_target_value,
       corrected_achieved_value::text as corrected_achieved_value,
       corrected_made, reason, reviewed_by_account_id, reviewed_at
     from pilot.training_attempt_reviews
     where organization_id = $1 and review_id = $2`,
    [input.organizationId, reviewId],
  );
}

/** Every review of one attempt, newest first -- the disagreement history that
 * BASE-06 keeps visible. Org- and attempt-scoped. */
export async function listReviews(
  organizationId: string,
  attemptId: string,
): Promise<AttemptReviewRow[]> {
  return query<AttemptReviewRow>(
    `select organization_id, review_id, attempt_id, review_state,
       corrected_target_value::text as corrected_target_value,
       corrected_achieved_value::text as corrected_achieved_value,
       corrected_made, reason, reviewed_by_account_id, reviewed_at
     from pilot.training_attempt_reviews
     where organization_id = $1 and attempt_id = $2
     order by reviewed_at desc, review_id desc`,
    [organizationId, attemptId],
  );
}
