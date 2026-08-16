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

export type AttemptMetricKind = 'reps' | 'time_seconds' | 'distance_m' | 'load_kg' | 'rounds' | 'hold_seconds';
export type AttemptDirection = 'at_least' | 'at_most';
export type AttemptContextType =
  | 'session' | 'drill_assignment' | 'assessment' | 'film_study' | 'open_floor'
  | 'technical_sparring' | 'sparring_games' | 'sparring_drills' | 'open_sparring';

export const ATTEMPT_METRIC_KINDS: readonly AttemptMetricKind[] = [
  'reps', 'time_seconds', 'distance_m', 'load_kg', 'rounds', 'hold_seconds',
];

// Sparring contexts are first-class (owner decision 2026-08-16): where an
// attempt fails matters as much as that it failed. A defense that holds in
// sparring drills and breaks in open sparring is a transfer fact.
export const ATTEMPT_CONTEXT_TYPES: readonly AttemptContextType[] = [
  'session', 'drill_assignment', 'assessment', 'film_study', 'open_floor',
  'technical_sparring', 'sparring_games', 'sparring_drills', 'open_sparring',
];

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
}

const FIELDS = `t.organization_id, t.attempt_id, t.athlete_id, a.full_name as athlete_name,
  t.context_type, t.context_id, t.metric_kind, t.direction,
  t.target_value::text as target_value, t.achieved_value::text as achieved_value,
  t.made, t.note, t.attempted_at`;

const FROM = `from pilot.training_attempts t
  join pilot.athletes a
    on a.organization_id = t.organization_id and a.athlete_id = t.athlete_id`;

export function isAttemptMetricKind(value: unknown): value is AttemptMetricKind {
  return typeof value === 'string' && (ATTEMPT_METRIC_KINDS as readonly string[]).includes(value);
}

export function isAttemptContextType(value: unknown): value is AttemptContextType {
  return typeof value === 'string' && (ATTEMPT_CONTEXT_TYPES as readonly string[]).includes(value);
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
     where t.organization_id = $1 and t.attempt_id = $2`,
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
     where t.organization_id = $1 and t.athlete_id = $2
       and ($3::text is null or t.metric_kind = $3)
     order by t.attempted_at desc
     limit ${limit}`,
    [organizationId, athleteId, filter.metricKind ?? null],
  );
}
