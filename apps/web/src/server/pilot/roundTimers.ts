import type { PoolClient } from 'pg';

import { query, withTransaction } from './db';
import { SessionScriptRunError } from './sessionScriptRuns';

// The round clock of a live session run (WO-N1-03, issue #1460): rounds of work and rest that the
// coach configures, starts, pauses, resumes and ends, shown on every TV showing the run.
//
// Table owned by infra/azure/pilot_slice_postgres_round_timers_migration.sql. Nothing here issues
// DDL.
//
// THE SERVER OWNS THE CLOCK, as sessionScriptRuns.ts does for the session. Only the configuration
// and the start, pause and end instants are stored, each written with the database's now(). The
// round, work or rest, and the seconds left are derived at read time (deriveRoundTimer) against the
// database clock, so a TV that reloads and a second screen of the coach read the same round.
//
// WHO MAY DRIVE IT: exactly who may pause and resume the run itself -- the coach delivering it, from
// any of their screens. Another coach's run id answers 404, as sessionScriptRuns.ts
// requireOwnLiveRun does. No other rule is added here.
//
// A TIMER STARTS ONLY ON THE COACH'S START (N1-03-Q1 A). Configuring writes 'ready'.
//
// IT IS AN INDEPENDENT CLOCK. Pausing the session does not pause the rounds, and finishing the run
// writes nothing here: once the run is not live its timer state means nothing, and no reader shows
// it (the TV shows only a live run; the coach's read answers 409). A later reader of history must
// treat a timer on a settled run as ended.

export type RoundTimerState = 'ready' | 'running' | 'paused' | 'ended';

/** What the room sees right now. 'done' is a running timer whose last round has finished. */
export type RoundTimerPhase = 'ready' | 'work' | 'rest' | 'done' | 'ended';

export interface RoundTimerSettings {
  roundSeconds: number;
  restSeconds: number;
  roundsTotal: number;
}

export const ROUND_TIMER_LIMITS = {
  roundSeconds: { min: 1, max: 3600 },
  restSeconds: { min: 0, max: 3600 },
  roundsTotal: { min: 1, max: 100 },
} as const;

export interface RoundTimerRow {
  round_seconds: number;
  rest_seconds: number;
  rounds_total: number;
  state: RoundTimerState;
  started_at: Date | string | null;
  paused_at: Date | string | null;
  paused_seconds: number;
  server_time: Date | string;
}

// THE ALLOWLIST for every screen that shows a timer, the TV included. No person field, no account
// id: configured_by_account_id stays in the database.
export const ROUND_TIMER_FIELDS = [
  'state',
  'phase',
  'round',
  'rounds_total',
  'round_seconds',
  'rest_seconds',
  'seconds_left',
  'is_paused',
] as const;

export interface RoundTimerView {
  state: RoundTimerState;
  phase: RoundTimerPhase;
  /** 1-based round the room is in (or resting after); 0 before the start. */
  round: number;
  rounds_total: number;
  round_seconds: number;
  rest_seconds: number;
  /** Seconds left in the current work or rest period; 0 when ready, done or ended. */
  seconds_left: number;
  is_paused: boolean;
}

function epochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Whole seconds of rounds the room has run: paused time and every adjustment taken off. */
function elapsedSeconds(row: RoundTimerRow): number {
  if (!row.started_at) return 0;
  const reference = row.paused_at ? epochMs(row.paused_at) : epochMs(row.server_time);
  return Math.max(0, Math.floor((reference - epochMs(row.started_at)) / 1000) - row.paused_seconds);
}

/**
 * The room's reading at `server_time`. Pure: the same row and clock always give the same answer,
 * which is what lets two screens agree. Rounds run work, rest, work, rest ... work: there is no
 * rest after the last round.
 */
export function deriveRoundTimer(row: RoundTimerRow): RoundTimerView {
  const base = {
    state: row.state,
    rounds_total: row.rounds_total,
    round_seconds: row.round_seconds,
    rest_seconds: row.rest_seconds,
    is_paused: row.state === 'paused',
  };
  if (row.state === 'ready' || !row.started_at) {
    return { ...base, phase: row.state === 'ended' ? 'ended' : 'ready', round: 0, seconds_left: 0 };
  }
  if (row.state === 'ended') {
    return { ...base, phase: 'ended', round: 0, seconds_left: 0 };
  }

  const elapsed = elapsedSeconds(row);
  const cycle = row.round_seconds + row.rest_seconds;
  const total = row.rounds_total * row.round_seconds + (row.rounds_total - 1) * row.rest_seconds;
  if (elapsed >= total) {
    return { ...base, phase: 'done', round: row.rounds_total, seconds_left: 0 };
  }
  const index = Math.floor(elapsed / cycle);
  const into = elapsed - index * cycle;
  if (into < row.round_seconds) {
    return { ...base, phase: 'work', round: index + 1, seconds_left: row.round_seconds - into };
  }
  return { ...base, phase: 'rest', round: index + 1, seconds_left: cycle - into };
}

const TIMER_COLUMNS = `t.round_seconds, t.rest_seconds, t.rounds_total, t.state, t.started_at, t.paused_at,
  t.paused_seconds, now() as server_time`;

interface RunOwnership {
  delivered_by_account_id: string;
  run_state: string | null;
}

// The run must be the caller's own and live. The same codes as sessionScriptRuns.ts
// requireOwnLiveRun: another coach's run reads exactly like a missing one.
function assertOwnLiveRun(row: RunOwnership | undefined, accountId: string): void {
  if (!row || row.delivered_by_account_id !== accountId) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_FOUND', 404);
  }
  if (row.run_state !== 'in_progress') {
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
}

// Read under a row lock, so a finish cannot land between this check and the timer write.
async function lockOwnLiveRun(client: PoolClient, organizationId: string, accountId: string, runId: string): Promise<void> {
  const run = await client.query<RunOwnership>(
    `select delivered_by_account_id, run_state
       from pilot.session_script_runs
      where organization_id = $1 and run_id = $2
        for update`,
    [organizationId, runId],
  );
  assertOwnLiveRun(run.rows[0], accountId);
}

async function readLocked(client: PoolClient, organizationId: string, runId: string): Promise<RoundTimerRow | null> {
  const rows = await client.query<RoundTimerRow>(
    `select ${TIMER_COLUMNS}
       from pilot.round_timers t
      where t.organization_id = $1 and t.run_id = $2
        for update`,
    [organizationId, runId],
  );
  return rows.rows[0] ?? null;
}

/**
 * Set round length, rest and round count. Allowed before the start and after an end, which puts
 * the timer back to ready for another set; refused while it runs or is paused, so a change never
 * moves the room's clock under it.
 */
export async function configureRoundTimer(
  organizationId: string,
  accountId: string,
  runId: string,
  settings: RoundTimerSettings,
): Promise<RoundTimerView> {
  return withTransaction(async (client) => {
    await lockOwnLiveRun(client, organizationId, accountId, runId);
    const existing = await readLocked(client, organizationId, runId);
    if (existing && (existing.state === 'running' || existing.state === 'paused')) {
      throw new SessionScriptRunError('ROUND_TIMER_RUNNING', 409);
    }
    const written = await client.query<RoundTimerRow>(
      `insert into pilot.round_timers as t
         (organization_id, run_id, round_seconds, rest_seconds, rounds_total, state, configured_by_account_id)
       values ($1, $2, $3, $4, $5, 'ready', $6)
       on conflict (organization_id, run_id) do update
         set round_seconds = excluded.round_seconds,
             rest_seconds = excluded.rest_seconds,
             rounds_total = excluded.rounds_total,
             state = 'ready',
             started_at = null,
             paused_at = null,
             paused_seconds = 0,
             ended_at = null,
             configured_by_account_id = excluded.configured_by_account_id,
             updated_at = now()
       returning ${TIMER_COLUMNS}`,
      [organizationId, runId, settings.roundSeconds, settings.restSeconds, settings.roundsTotal, accountId],
    );
    return deriveRoundTimer(written.rows[0]);
  });
}

export type RoundTimerAction = 'start' | 'pause' | 'resume' | 'end';

// Each action names the states it moves from and the state it lands in. An action asking for the
// state the timer is already in (a retried or second-screen tap) answers with the timer as it is and
// writes nothing -- as the run's own pause is idempotent -- so a second "pause" can never restart the
// pause instant. Any other move from the wrong state is refused.
const TRANSITIONS: Record<RoundTimerAction, { from: readonly RoundTimerState[]; to: RoundTimerState; set: string }> = {
  start: { from: ['ready'], to: 'running', set: `state = 'running', started_at = now()` },
  pause: { from: ['running'], to: 'paused', set: `state = 'paused', paused_at = now()` },
  resume: {
    from: ['paused'],
    to: 'running',
    set: `state = 'running',
          paused_seconds = t.paused_seconds + greatest(0, floor(extract(epoch from (now() - t.paused_at)))::int),
          paused_at = null`,
  },
  end: {
    from: ['ready', 'running', 'paused'],
    to: 'ended',
    set: `state = 'ended',
          ended_at = greatest(now(), coalesce(t.started_at, now())),
          paused_seconds = t.paused_seconds
            + case when t.paused_at is null then 0 else greatest(0, floor(extract(epoch from (now() - t.paused_at)))::int) end,
          paused_at = null`,
  },
};

export async function moveRoundTimer(
  organizationId: string,
  accountId: string,
  runId: string,
  action: RoundTimerAction,
): Promise<RoundTimerView> {
  const transition = TRANSITIONS[action];
  return withTransaction(async (client) => {
    await lockOwnLiveRun(client, organizationId, accountId, runId);
    const existing = await readLocked(client, organizationId, runId);
    if (!existing) {
      throw new SessionScriptRunError('ROUND_TIMER_NOT_SET', 409);
    }
    if (existing.state === transition.to) {
      return deriveRoundTimer(existing);
    }
    if (!transition.from.includes(existing.state)) {
      throw new SessionScriptRunError(`ROUND_TIMER_${existing.state.toUpperCase()}`, 409);
    }
    const written = await client.query<RoundTimerRow>(
      `update pilot.round_timers as t
          set ${transition.set}, updated_at = now()
        where t.organization_id = $1 and t.run_id = $2
        returning ${TIMER_COLUMNS}`,
      [organizationId, runId],
    );
    return deriveRoundTimer(written.rows[0]);
  });
}

// +30 SEC AND REPEAT (OD-2026-10-17-010, "A": built after the restyle; +30 timing "A: After 30 sec").
//
// Both move the room's clock BACK by adding to paused_seconds, which every reader already takes off
// the elapsed time, so no column is added and the TV needs no change: it derives the new reading
// like any other.
//   +30 SEC  gives the current work or rest period thirty more seconds. Pushing the clock back 30 s
//            is exact only once the period is 30 s old -- earlier, it would rewind into the period
//            before -- so it is refused until then (Jason's "After 30 sec").
//   REPEAT   runs the round again: back to the start of this round while it is being worked, or of
//            the round just finished during its rest or after the last one. The round number shows
//            again and the TV rings its start bell again.
// Neither is a TRANSITIONS row: the state does not change, and moveRoundTimer answers a same-state
// move as a no-op. Each is a COMPARE-AND-SET on the revision the coach's screen last read, so a
// retried tap, or the same tap from a second screen, cannot add twice: the second answers
// ROUND_TIMER_STALE and that screen reads again.
export type RoundTimerAdjustment = 'add_30' | 'repeat';
export const ROUND_TIMER_ADD_SECONDS = 30;

/** How far back an adjustment moves the clock, or the code it is refused with. Pure. */
export function adjustmentShift(row: RoundTimerRow, adjustment: RoundTimerAdjustment): { shift: number } | { refused: string } {
  const view = deriveRoundTimer(row);
  if (view.state === 'ready' || view.state === 'ended') return { refused: `ROUND_TIMER_${view.state.toUpperCase()}` };
  const cycle = row.round_seconds + row.rest_seconds;
  if (view.phase === 'done') {
    if (adjustment === 'add_30') return { refused: 'ROUND_TIMER_DONE' };
    return { shift: elapsedSeconds(row) - (row.rounds_total - 1) * cycle };
  }
  const into = view.phase === 'work' ? row.round_seconds - view.seconds_left : row.rest_seconds - view.seconds_left;
  if (adjustment === 'add_30') {
    return into >= ROUND_TIMER_ADD_SECONDS ? { shift: ROUND_TIMER_ADD_SECONDS } : { refused: 'ROUND_TIMER_TOO_EARLY' };
  }
  return { shift: view.phase === 'work' ? into : into + row.round_seconds };
}

// The row's last write, to the microsecond, as text: the revision a screen read and sends back.
const REVISION = `(extract(epoch from t.updated_at) * 1000000)::bigint::text`;

/** The revision of a run's timer row, for the coach's screens; null when no timer is set. */
export async function readRoundTimerRevision(organizationId: string, runId: string): Promise<string | null> {
  const rows = await query<{ revision: string }>(
    `select ${REVISION} as revision from pilot.round_timers t where t.organization_id = $1 and t.run_id = $2`,
    [organizationId, runId],
  );
  return rows[0]?.revision ?? null;
}

export async function adjustRoundTimer(
  organizationId: string,
  accountId: string,
  runId: string,
  adjustment: RoundTimerAdjustment,
  revision: string,
): Promise<{ timer: RoundTimerView; revision: string }> {
  return withTransaction(async (client) => {
    await lockOwnLiveRun(client, organizationId, accountId, runId);
    const existing = await client.query<RoundTimerRow & { revision: string }>(
      `select ${TIMER_COLUMNS}, ${REVISION} as revision
         from pilot.round_timers t
        where t.organization_id = $1 and t.run_id = $2
          for update`,
      [organizationId, runId],
    );
    const row = existing.rows[0];
    if (!row) throw new SessionScriptRunError('ROUND_TIMER_NOT_SET', 409);
    if (row.revision !== revision) throw new SessionScriptRunError('ROUND_TIMER_STALE', 409);
    const move = adjustmentShift(row, adjustment);
    if ('refused' in move) throw new SessionScriptRunError(move.refused, 409);
    const written = await client.query<RoundTimerRow & { revision: string }>(
      `update pilot.round_timers as t
          set paused_seconds = t.paused_seconds + $3, updated_at = now()
        where t.organization_id = $1 and t.run_id = $2
        returning ${TIMER_COLUMNS}, ${REVISION} as revision`,
      [organizationId, runId, move.shift],
    );
    return { timer: deriveRoundTimer(written.rows[0]), revision: written.rows[0].revision };
  });
}

/** The caller's own live run's timer, for the coach's screens. Same 404 as the run actions. */
export async function readOwnRoundTimer(
  organizationId: string,
  accountId: string,
  runId: string,
): Promise<RoundTimerView | null> {
  const rows = await query<RunOwnership & { has_timer: boolean } & Partial<RoundTimerRow>>(
    `select r.delivered_by_account_id, r.run_state, t.run_id is not null as has_timer,
            ${TIMER_COLUMNS}
       from pilot.session_script_runs r
       left join pilot.round_timers t on t.organization_id = r.organization_id and t.run_id = r.run_id
      where r.organization_id = $1 and r.run_id = $2`,
    [organizationId, runId],
  );
  assertOwnLiveRun(rows[0], accountId);
  return rows[0].has_timer ? deriveRoundTimer(rows[0] as RoundTimerRow) : null;
}
