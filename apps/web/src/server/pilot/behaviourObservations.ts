import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query, withTransaction } from './db';
import { ValidationError } from './errors';
import type {
  AttributionCertainty,
  AttributionTarget,
  FatigueContext,
  ObservationPolarity,
  TaskConstraint,
} from './patterns';

// The learning loop's writer (lane L49): the gym's shared list of behaviour
// names (Jason 2026-10-18 Q1, "A: Shared growing list") and a coach's report of
// what an athlete did (pilot.behaviour_observations, staff only, Q2). Nothing
// here evaluates anything -- the pattern and lesson evaluators read these rows
// later -- and nothing here decides what a report means.
//
// ONE EPISODE PER ATTEMPT. A report about a logged training attempt belongs to
// that attempt's episode; a report "of the same moment" as another joins its
// episode; anything else starts a new one. A coach's own second report of an
// episode is a revision of their first, so one person's changed call never
// counts twice. The database holds every rule this writer relies on
// (infra/azure/pilot_slice_postgres_learning_loop_migration.sql); the checks
// here give the coach the reason instead of a 500.

export const TASK_CONSTRAINTS = ['controlled', 'constrained_live', 'live'] as const satisfies readonly TaskConstraint[];
export const FATIGUE_CONTEXTS = ['fresh', 'moderate', 'fatigued', 'unknown'] as const satisfies readonly FatigueContext[];
export const POLARITIES = ['occurrence', 'counterexample'] as const satisfies readonly ObservationPolarity[];
export const ATTRIBUTION_TARGETS = [
  'athlete', 'coach_cue', 'task_design', 'partner_role', 'environment', 'equipment', 'unresolved',
] as const satisfies readonly AttributionTarget[];
export const ATTRIBUTION_CERTAINTIES = ['stated', 'probable', 'uncertain'] as const satisfies readonly AttributionCertainty[];

/** The training-attempt context types (pilot.training_attempts.context_type), for a report with no drill. */
export const ATTEMPT_CONTEXTS = [
  'session', 'drill_assignment', 'assessment', 'film_study', 'open_floor',
  'technical_sparring', 'sparring_games', 'sparring_drills', 'open_sparring',
] as const;

/**
 * How well the coach could see it. Unsaid is 'moderate': the evaluators read
 * source quality only to drop a failed capture and to flag a low one
 * (patterns/promotion.ts), so the unmarked middle changes no count and adds
 * no warning.
 */
const VIEW_QUALITY = { clear: 'high', partial: 'low' } as const;
export type ViewQuality = keyof typeof VIEW_QUALITY;

export const BEHAVIOUR_KEY_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
/** The skill code shape (contentImport/ids.ts SKILL_CODE_PATTERN). */
export const SKILL_CODE_PATTERN = /^SK-[A-Z]+-\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[^\s]{1,200}$/;
export const MAX_NOTE_LENGTH = 2000;

export interface BehaviourKeyRow {
  behaviour_key: string;
  label: string;
  skill_id: string;
  status: 'active' | 'retired';
  created_at: string;
}

export interface BehaviourObservationRow {
  observation_id: string;
  athlete_id: string;
  behaviour_key: string;
  behaviour_label: string;
  episode_id: string;
  session_key: string;
  task_context_key: string;
  task_constraint: TaskConstraint;
  fatigue_context: FatigueContext;
  polarity: ObservationPolarity;
  attribution_target: AttributionTarget;
  attribution_certainty: AttributionCertainty;
  source_quality: string;
  observer_account_id: string | null;
  author_role: string;
  supersedes_observation_id: string | null;
  note: string;
  observed_at: string;
  created_at: string;
}

export async function listBehaviourKeys(organizationId: string): Promise<BehaviourKeyRow[]> {
  return query<BehaviourKeyRow>(
    `select behaviour_key, label, skill_id, status, created_at
       from pilot.behaviour_keys
      where organization_id = $1
      order by status, label`,
    [organizationId],
  );
}

export async function createBehaviourKey(input: {
  organizationId: string;
  behaviourKey: string;
  label: string;
  skillId: string;
  createdByAccountId: string;
}): Promise<BehaviourKeyRow> {
  if (!BEHAVIOUR_KEY_PATTERN.test(input.behaviourKey)) {
    throw new ValidationError('A behaviour key is 3-80 lower-case letters, digits or underscores, starting with a letter.');
  }
  const label = input.label.trim();
  if (label.length < 3 || label.length > 120) {
    throw new ValidationError('A behaviour name is 3-120 characters.');
  }
  if (!SKILL_CODE_PATTERN.test(input.skillId)) {
    throw new ValidationError('A behaviour name sits under one skill code, such as SK-JAB-01.');
  }
  try {
    const rows = await query<BehaviourKeyRow>(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, $2, $3, $4, $5)
       returning behaviour_key, label, skill_id, status, created_at`,
      [input.organizationId, input.behaviourKey, label, input.skillId, input.createdByAccountId],
    );
    return rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ValidationError('That behaviour key is already on the list.');
    }
    throw refusalFrom(error);
  }
}

export type SessionRef = { runId: string } | { date: string };
export type ContextRef = { drillId: string } | { blockId: string } | { attemptContext: string };

export interface RecordBehaviourObservationInput {
  organizationId: string;
  athleteId: string;
  behaviourKey: string;
  observerAccountId: string;
  authorRole: string;
  session: SessionRef;
  context: ContextRef;
  /** The logged training attempt this report is about: its episode. */
  trainingAttemptId?: string;
  /** Another report of the same moment: this report joins its episode. */
  sameMomentAs?: string;
  taskConstraint: string;
  fatigueContext?: string;
  polarity: string;
  attributionTarget: string;
  attributionCertainty: string;
  viewQuality?: string;
  note?: string;
  observedAt?: string;
}

const REFUSALS: Record<string, string> = {
  pilot_behaviour_observations_live_athlete: 'That athlete is not on this gym\'s roster.',
  pilot_behaviour_observations_observer_of_this_gym: 'Only staff of this gym can file a behaviour report.',
  pilot_behaviour_observations_active_key: 'That behaviour name is not on the active list.',
  pilot_behaviour_observations_one_episode:
    'A report of the same moment must be about the same athlete, behaviour, session and drill.',
  pilot_behaviour_observations_own_revision: 'A report can only revise your own earlier report of the same moment.',
  pilot_behaviour_keys_creator_of_this_gym: 'Only staff of this gym can add a behaviour name.',
};

/** A database refusal this writer can name, as the coach-readable reason; anything else unchanged. */
function refusalFrom(error: unknown): unknown {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError.code === '23514' && pgError.constraint && REFUSALS[pgError.constraint]) {
    return new ValidationError(REFUSALS[pgError.constraint]);
  }
  // Two revisions of one report at once: the second finds it already revised.
  if (pgError.code === '23505' && pgError.constraint === 'idx_behaviour_observations_one_successor') {
    return new ValidationError('That report was just revised. Reload and try again.');
  }
  return error;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function plainId(value: string, field: string): string {
  if (!ID_PATTERN.test(value)) throw new ValidationError(`${field} is invalid.`);
  return value;
}

async function exists(client: PoolClient, sql: string, params: unknown[]): Promise<boolean> {
  return (await client.query(sql, params)).rows.length > 0;
}

async function sessionKeyFor(client: PoolClient, organizationId: string, session: SessionRef): Promise<string> {
  if ('runId' in session) {
    const runId = plainId(session.runId, 'session run');
    const found = await exists(
      client,
      'select 1 from pilot.session_script_runs where organization_id = $1 and run_id = $2',
      [organizationId, runId],
    );
    if (!found) throw new ValidationError('That session run is not in this gym.');
    return `run:${runId}`;
  }
  if (!DATE_PATTERN.test(session.date) || Number.isNaN(Date.parse(`${session.date}T00:00:00Z`))) {
    throw new ValidationError('A session day is a date, YYYY-MM-DD.');
  }
  return `day:${session.date}`;
}

async function contextKeyFor(client: PoolClient, organizationId: string, context: ContextRef): Promise<string> {
  if ('drillId' in context) {
    const drillId = plainId(context.drillId, 'drill');
    const found = await exists(
      client,
      'select 1 from pilot.drill_library where organization_id = $1 and drill_id = $2',
      [organizationId, drillId],
    );
    if (!found) throw new ValidationError('That drill is not in this gym\'s library.');
    return `drill:${drillId}`;
  }
  if ('blockId' in context) {
    const blockId = plainId(context.blockId, 'session block');
    const found = await exists(
      client,
      'select 1 from pilot.session_script_blocks where organization_id = $1 and block_id = $2',
      [organizationId, blockId],
    );
    if (!found) throw new ValidationError('That session block is not in this gym.');
    return `block:${blockId}`;
  }
  return `context:${oneOf(context.attemptContext, ATTEMPT_CONTEXTS, 'context')}`;
}

async function episodeFor(
  client: PoolClient,
  input: RecordBehaviourObservationInput,
): Promise<string> {
  if (input.trainingAttemptId && input.sameMomentAs) {
    throw new ValidationError('Name the training attempt or the report of the same moment, not both.');
  }
  if (input.trainingAttemptId) {
    const attemptId = plainId(input.trainingAttemptId, 'training attempt');
    // The attempt must be THIS athlete's: an episode names one athlete.
    const found = await exists(
      client,
      `select 1 from pilot.training_attempts
        where organization_id = $1 and attempt_id = $2 and athlete_id = $3`,
      [input.organizationId, attemptId, input.athleteId],
    );
    if (!found) throw new ValidationError('That training attempt is not this athlete\'s.');
    return `attempt:${attemptId}`;
  }
  if (input.sameMomentAs) {
    const earlier = await client.query<{ episode_id: string }>(
      `select episode_id from pilot.behaviour_observations
        where organization_id = $1 and observation_id::text = $2 and athlete_id = $3`,
      [input.organizationId, plainId(input.sameMomentAs, 'report'), input.athleteId],
    );
    if (earlier.rows.length === 0) throw new ValidationError('That report is not this athlete\'s.');
    return earlier.rows[0].episode_id;
  }
  return `ep:${randomUUID()}`;
}

export async function recordBehaviourObservation(
  input: RecordBehaviourObservationInput,
): Promise<BehaviourObservationRow> {
  const taskConstraint = oneOf(input.taskConstraint, TASK_CONSTRAINTS, 'taskConstraint');
  const fatigueContext = oneOf(input.fatigueContext ?? 'unknown', FATIGUE_CONTEXTS, 'fatigueContext');
  const polarity = oneOf(input.polarity, POLARITIES, 'polarity');
  const attributionTarget = oneOf(input.attributionTarget, ATTRIBUTION_TARGETS, 'attributionTarget');
  const attributionCertainty = oneOf(input.attributionCertainty, ATTRIBUTION_CERTAINTIES, 'attributionCertainty');
  const sourceQuality = input.viewQuality === undefined
    ? 'moderate'
    : VIEW_QUALITY[oneOf(input.viewQuality, Object.keys(VIEW_QUALITY) as ViewQuality[], 'viewQuality')];
  const note = (input.note ?? '').trim();
  if (note.length > MAX_NOTE_LENGTH) throw new ValidationError(`A note is at most ${MAX_NOTE_LENGTH} characters.`);
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt))) throw new ValidationError('observedAt is not a time.');

  try {
    return await withTransaction(async (client) => {
      const sessionKey = await sessionKeyFor(client, input.organizationId, input.session);
      const taskContextKey = await contextKeyFor(client, input.organizationId, input.context);
      const episodeId = await episodeFor(client, input);
      // This observer's own latest report of the episode, if any: the new
      // report revises it rather than counting a second time.
      const own = await client.query<{ observation_id: string }>(
        `select o.observation_id from pilot.behaviour_observations o
          where o.organization_id = $1 and o.episode_id = $2 and o.observer_account_id = $3
            and not exists (
              select 1 from pilot.behaviour_observations s
               where s.organization_id = o.organization_id and s.supersedes_observation_id = o.observation_id)
          order by o.created_at desc
          limit 1`,
        [input.organizationId, episodeId, input.observerAccountId],
      );
      const inserted = await client.query<{ observation_id: string }>(
        `insert into pilot.behaviour_observations
           (organization_id, athlete_id, behaviour_key, episode_id, session_key, task_context_key,
            task_constraint, fatigue_context, polarity, attribution_target, attribution_certainty,
            source_type, source_quality, interpretation, observer_account_id, author_role,
            supersedes_observation_id, note, observed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'coach_tag', $12, 'human_observed',
                 $13, $14, $15, $16, $17)
         returning observation_id`,
        [
          input.organizationId, input.athleteId, input.behaviourKey, episodeId, sessionKey, taskContextKey,
          taskConstraint, fatigueContext, polarity, attributionTarget, attributionCertainty, sourceQuality,
          input.observerAccountId, input.authorRole, own.rows[0]?.observation_id ?? null, note, observedAt,
        ],
      );
      const rows = await client.query<BehaviourObservationRow>(
        `${OBSERVATION_SELECT} where o.organization_id = $1 and o.observation_id = $2`,
        [input.organizationId, inserted.rows[0].observation_id],
      );
      return rows.rows[0];
    });
  } catch (error) {
    throw refusalFrom(error);
  }
}

const OBSERVATION_SELECT = `select o.observation_id, o.athlete_id, o.behaviour_key, k.label as behaviour_label,
       o.episode_id, o.session_key, o.task_context_key, o.task_constraint, o.fatigue_context, o.polarity,
       o.attribution_target, o.attribution_certainty, o.source_quality, o.observer_account_id, o.author_role,
       o.supersedes_observation_id, o.note, o.observed_at, o.created_at
  from pilot.behaviour_observations o
  join pilot.behaviour_keys k on k.organization_id = o.organization_id and k.behaviour_key = o.behaviour_key`;

/** One athlete's reports, newest first, as written: no evaluation, revisions included. */
export async function listBehaviourObservations(
  organizationId: string,
  athleteId: string,
  limit = 200,
): Promise<BehaviourObservationRow[]> {
  return query<BehaviourObservationRow>(
    `${OBSERVATION_SELECT}
      where o.organization_id = $1 and o.athlete_id = $2
      order by o.observed_at desc, o.created_at desc
      limit $3`,
    [organizationId, athleteId, Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
}
