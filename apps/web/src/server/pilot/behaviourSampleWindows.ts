import {
  POLARITIES,
  TASK_CONSTRAINTS,
  recordBehaviourObservation,
  reportPlaceFor,
  windowEpisodeId,
  type ContextRef,
} from './behaviourObservations';
import { query, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';

// PATTERN-1d (lane PATTERN-1; PunxsyProminence/ppbf-platform#2082): a SAMPLED
// WINDOW (OD-2026-11-21-004 LL-Q1, "Sampled window"; Overwatch Q2 A, Q3 A, Q5 A,
// Q7 A, Q8 A). In a live class a coach opens a window on one athlete and one
// behaviour, in one drill or context, sets the task constraint once and a
// number of chances (ten unless set), and taps shown / not shown per chance.
//
// Every tap is a behaviour report written by the existing writer, with its
// presence, drill and revision checks, and its episode fixed by window and
// chance (behaviourObservations.ts windowEpisodeId): a second coach who taps
// the same chance codes the same attempt, and a coach's second tap of a chance
// revises their first ("Change last tap", Q8 A). A tap says nothing about
// whose fault it was, so it records that as unsaid (Q3 A). Through these
// functions a coach reads back only their own taps, and a tap returns nothing
// of anyone else's: a second coach joins blind (Q2 A). (The reports route
// lists every report of an athlete to staff, taps included: which screen calls
// it during a window is PATTERN-1e's and 1f's.)
//
// Staff only, like the reports (privacyTiers.ts): opening and tapping by the
// table guards, closing and reading back by an active staff membership of this
// gym checked here. No route calls these yet: the window routes are PATTERN-1e.

export const DEFAULT_WINDOW_CHANCES = 10;
export const MAX_WINDOW_CHANCES = 50;

export interface BehaviourWindowRow {
  window_id: string;
  athlete_id: string;
  behaviour_key: string;
  run_id: string;
  context_kind: 'drill' | 'block' | 'context';
  context_id: string;
  task_constraint: string;
  chances: number;
  opened_by_account_id: string | null;
  opened_by_role: string;
  opened_at: string;
  closed_at: string | null;
}

const FIELDS = `window_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint, chances,
  opened_by_account_id, opened_by_role, opened_at, closed_at`;

const REFUSALS: Record<string, string> = {
  pilot_behaviour_windows_live_athlete: 'That athlete is not on this gym\'s roster.',
  pilot_behaviour_windows_opener_of_this_gym: 'Only staff of this gym can open a window.',
  pilot_behaviour_windows_role_check: 'Only staff of this gym can open a window.',
  pilot_behaviour_windows_present_on_run: 'That athlete is not marked present in that session run.',
  pilot_behaviour_windows_context_of_this_gym: 'That drill or session block is not in this gym.',
  pilot_behaviour_windows_active_key: 'That behaviour name is not on the active list.',
};

/** Ten unless the coach says otherwise; a whole number from 1 to 50 (Q7 A). */
export function windowChances(value: unknown): number {
  if (value === undefined) return DEFAULT_WINDOW_CHANCES;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_WINDOW_CHANCES) {
    throw new ValidationError(`A window has 1 to ${MAX_WINDOW_CHANCES} chances.`);
  }
  return value;
}

/** The drill or context a window is about, as the writer takes it. */
export function contextOf(row: Pick<BehaviourWindowRow, 'context_kind' | 'context_id'>): ContextRef {
  if (row.context_kind === 'drill') return { drillId: row.context_id };
  if (row.context_kind === 'block') return { blockId: row.context_id };
  return { attemptContext: row.context_id };
}

export async function openBehaviourWindow(input: {
  organizationId: string;
  athleteId: string;
  behaviourKey: string;
  runId: string;
  context: ContextRef;
  taskConstraint: string;
  chances?: number;
  openedByAccountId: string;
  openedByRole: string;
}): Promise<BehaviourWindowRow> {
  if (!(TASK_CONSTRAINTS as readonly string[]).includes(input.taskConstraint)) {
    throw new ValidationError(`taskConstraint must be one of: ${TASK_CONSTRAINTS.join(', ')}.`);
  }
  const chances = windowChances(input.chances);
  const [contextKind, contextId] = 'drillId' in input.context ? ['drill', input.context.drillId]
    : 'blockId' in input.context ? ['block', input.context.blockId]
      : ['context', input.context.attemptContext];
  try {
    return await withTransaction(async (client) => {
      // The writer's own checks: the run is this gym's, the athlete is marked
      // present on it, and the drill or block was part of it (Q5 A).
      await reportPlaceFor(client, {
        organizationId: input.organizationId, athleteId: input.athleteId, session: { runId: input.runId }, context: input.context,
      });
      const inserted = await client.query<BehaviourWindowRow>(
        `insert into pilot.behaviour_observations_windows
           (organization_id, athlete_id, behaviour_key, run_id, context_kind, context_id, task_constraint, chances,
            opened_by_account_id, opened_by_role)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ${FIELDS}`,
        [
          input.organizationId, input.athleteId, input.behaviourKey, input.runId, contextKind, contextId,
          input.taskConstraint, chances, input.openedByAccountId, input.openedByRole,
        ],
      );
      return inserted.rows[0];
    });
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === '23514' && pgError.constraint && REFUSALS[pgError.constraint]) {
      throw new ValidationError(REFUSALS[pgError.constraint]);
    }
    if (pgError.code === '23503' && pgError.constraint === 'pilot_behaviour_windows_key_fk') {
      throw new ValidationError(REFUSALS.pilot_behaviour_windows_active_key);
    }
    throw error;
  }
}

const STAFF_ROLES = ['coach', 'organization_admin', 'admin'];

/** Fail closed: an active account with an active staff membership in this gym, as the table guards require. */
async function assertStaffOfThisGym(organizationId: string, accountId: string, what: string): Promise<void> {
  const rows = await query<{ ok: number }>(
    `select 1 as ok from pilot.organization_memberships om
       join pilot.accounts acc on acc.account_id = om.account_id
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag and om.role = any($3::text[])
        and acc.active_flag and acc.deleted_at is null`,
    [accountId, organizationId, STAFF_ROLES],
  );
  if (rows.length === 0) throw new ForbiddenError(`Only staff of this gym can ${what}.`);
}

async function windowOf(organizationId: string, windowId: string): Promise<BehaviourWindowRow> {
  const rows = await query<BehaviourWindowRow>(
    `select ${FIELDS} from pilot.behaviour_observations_windows
      where organization_id = $1 and window_id::text = $2`,
    [organizationId, windowId],
  );
  if (rows.length === 0) throw new ValidationError('That window is not in this gym.');
  return rows[0];
}

/** One tap: shown (occurrence) or not shown (counterexample) on one chance. */
export async function recordWindowTap(input: {
  organizationId: string;
  windowId: string;
  chance: number;
  polarity: string;
  observerAccountId: string;
  authorRole: string;
}): Promise<{ chance: number; polarity: string }> {
  if (!(POLARITIES as readonly string[]).includes(input.polarity)) {
    throw new ValidationError(`polarity must be one of: ${POLARITIES.join(', ')}.`);
  }
  const window = await windowOf(input.organizationId, input.windowId);
  // The writer re-reads the window in its own transaction, held until the
  // report commits: open, this chance in range, this athlete, behaviour, run, drill and task.
  const written = await recordBehaviourObservation({
    organizationId: input.organizationId,
    athleteId: window.athlete_id,
    behaviourKey: window.behaviour_key,
    observerAccountId: input.observerAccountId,
    authorRole: input.authorRole,
    session: { runId: window.run_id },
    context: contextOf(window),
    windowChance: { windowId: window.window_id, chance: input.chance },
    taskConstraint: window.task_constraint,
    polarity: input.polarity,
    attributionTarget: 'unresolved',
    attributionCertainty: 'uncertain',
  });
  // Only what this coach tapped: the report's time is the chance's first tap,
  // which may be another coach's (Q2 A: join blind).
  return { chance: input.chance, polarity: written.polarity };
}

export async function closeBehaviourWindow(input: {
  organizationId: string;
  windowId: string;
  closedByAccountId: string;
}): Promise<BehaviourWindowRow> {
  await assertStaffOfThisGym(input.organizationId, input.closedByAccountId, 'close a window');
  const closed = await query<BehaviourWindowRow>(
    `update pilot.behaviour_observations_windows set closed_at = now()
      where organization_id = $1 and window_id::text = $2 and closed_at is null
      returning ${FIELDS}`,
    [input.organizationId, input.windowId],
  );
  if (closed.length > 0) return closed[0];
  await windowOf(input.organizationId, input.windowId);
  throw new ValidationError('That window is already closed.');
}

/** This coach's own taps on a window, as they stand (revised ones replaced); no one else's (Q2 A). */
export async function listMyWindowTaps(input: {
  organizationId: string;
  windowId: string;
  observerAccountId: string;
}): Promise<{ chance: number; polarity: string }[]> {
  await assertStaffOfThisGym(input.organizationId, input.observerAccountId, 'read back window taps');
  const window = await windowOf(input.organizationId, input.windowId);
  const chanceOf = new Map(Array.from({ length: window.chances }, (_, index) => [
    windowEpisodeId(input.organizationId, window.window_id, index + 1), index + 1,
  ] as const));
  const rows = await query<{ episode_id: string; polarity: string }>(
    `select o.episode_id, o.polarity from pilot.behaviour_observations o
      where o.organization_id = $1 and o.episode_id = any($2::text[]) and o.observer_account_id = $3
        and not exists (
          select 1 from pilot.behaviour_observations s
           where s.organization_id = o.organization_id and s.supersedes_observation_id = o.observation_id)`,
    [input.organizationId, [...chanceOf.keys()], input.observerAccountId],
  );
  return rows
    .map((row) => ({ chance: chanceOf.get(row.episode_id) ?? 0, polarity: row.polarity }))
    .filter((tap) => tap.chance > 0)
    .sort((left, right) => left.chance - right.chance);
}
