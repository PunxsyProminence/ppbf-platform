import type { PoolClient } from 'pg';

import { query, withTransaction } from './db';
import { SessionScriptRunError } from './sessionScriptRuns';
import {
  adjustmentShift,
  deriveRoundTimer,
  type RevisedRoundTimer,
  type RoundTimerAction,
  type RoundTimerAdjustment,
  type RoundTimerRow,
  type RoundTimerSettings,
  type RoundTimerState,
  type RoundTimerView,
} from 'gym-tv-timer/roundTimers';

// The pure part of the round clock (types, limits, deriveRoundTimer, adjustmentShift) now lives in
// the gym-tv-timer package; every name this module exported before is still exported from here.
export * from 'gym-tv-timer/roundTimers';

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

// The row's last write, to the microsecond, as text: the revision a coach's screen read and sends
// back with +30 SEC or REPEAT. Selected WITH the timer, so a screen never pairs a timer with the
// revision of a later write.
const REVISION = `(extract(epoch from t.updated_at) * 1000000)::bigint::text`;

const TIMER_COLUMNS = `t.round_seconds, t.rest_seconds, t.rounds_total, t.state, t.started_at, t.paused_at,
  t.paused_seconds, now() as server_time, ${REVISION} as revision`;

type RevisedRow = RoundTimerRow & { revision: string };

function revised(row: RevisedRow): RevisedRoundTimer {
  return { timer: deriveRoundTimer(row), revision: row.revision };
}

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

async function readLocked(client: PoolClient, organizationId: string, runId: string): Promise<RevisedRow | null> {
  const rows = await client.query<RevisedRow>(
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
  return (await configureRoundTimerRevised(organizationId, accountId, runId, settings)).timer;
}

/** configureRoundTimer, with the revision of the row it wrote. */
export async function configureRoundTimerRevised(
  organizationId: string,
  accountId: string,
  runId: string,
  settings: RoundTimerSettings,
): Promise<RevisedRoundTimer> {
  return withTransaction(async (client) => {
    await lockOwnLiveRun(client, organizationId, accountId, runId);
    const existing = await readLocked(client, organizationId, runId);
    if (existing && (existing.state === 'running' || existing.state === 'paused')) {
      throw new SessionScriptRunError('ROUND_TIMER_RUNNING', 409);
    }
    const written = await client.query<RevisedRow>(
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
    return revised(written.rows[0]);
  });
}

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
  return (await moveRoundTimerRevised(organizationId, accountId, runId, action)).timer;
}

/** moveRoundTimer, with the revision of the row it wrote (or found, for a same-state move). */
export async function moveRoundTimerRevised(
  organizationId: string,
  accountId: string,
  runId: string,
  action: RoundTimerAction,
): Promise<RevisedRoundTimer> {
  const transition = TRANSITIONS[action];
  return withTransaction(async (client) => {
    await lockOwnLiveRun(client, organizationId, accountId, runId);
    const existing = await readLocked(client, organizationId, runId);
    if (!existing) {
      throw new SessionScriptRunError('ROUND_TIMER_NOT_SET', 409);
    }
    if (existing.state === transition.to) {
      return revised(existing);
    }
    if (!transition.from.includes(existing.state)) {
      throw new SessionScriptRunError(`ROUND_TIMER_${existing.state.toUpperCase()}`, 409);
    }
    const written = await client.query<RevisedRow>(
      `update pilot.round_timers as t
          set ${transition.set}, updated_at = now()
        where t.organization_id = $1 and t.run_id = $2
        returning ${TIMER_COLUMNS}`,
      [organizationId, runId],
    );
    return revised(written.rows[0]);
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
// ON THE TV (wallRoundTimer.ts): REPEAT reads as a fresh start of the round and rings its start bell;
// +30 gives back the round's knock and end bell (releasedKeys) so they ring at the new end. One edge
// is known: a +30 pressed 30-37 s into a period lands within the TV's freshness window of the start,
// which the TV cannot tell from a restart, so it can ring the start bell once (pinned in
// wallRoundTimer.test.ts). Opening +30 later would remove it; that is Jason's call, not ruled.
// Neither is a TRANSITIONS row: the state does not change, and moveRoundTimer answers a same-state
// move as a no-op. Each is a COMPARE-AND-SET on the revision the coach's screen last read, so a
// retried tap, or the same tap from a second screen, cannot add twice: the second answers
// ROUND_TIMER_STALE and that screen reads again.
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
): Promise<RevisedRoundTimer> {
  return withTransaction(async (client) => {
    await lockOwnLiveRun(client, organizationId, accountId, runId);
    const row = await readLocked(client, organizationId, runId);
    if (!row) throw new SessionScriptRunError('ROUND_TIMER_NOT_SET', 409);
    if (row.revision !== revision) throw new SessionScriptRunError('ROUND_TIMER_STALE', 409);
    const move = adjustmentShift(row, adjustment);
    if ('refused' in move) throw new SessionScriptRunError(move.refused, 409);
    const written = await client.query<RevisedRow>(
      `update pilot.round_timers as t
          set paused_seconds = t.paused_seconds + $3, updated_at = now()
        where t.organization_id = $1 and t.run_id = $2
        returning ${TIMER_COLUMNS}`,
      [organizationId, runId, move.shift],
    );
    return revised(written.rows[0]);
  });
}

/** The caller's own live run's timer, for the coach's screens. Same 404 as the run actions. */
export async function readOwnRoundTimer(
  organizationId: string,
  accountId: string,
  runId: string,
): Promise<RoundTimerView | null> {
  return (await readOwnRoundTimerRevised(organizationId, accountId, runId))?.timer ?? null;
}

/** readOwnRoundTimer, with the revision of the same row in the same select; null with no timer. */
export async function readOwnRoundTimerRevised(
  organizationId: string,
  accountId: string,
  runId: string,
): Promise<RevisedRoundTimer | null> {
  const rows = await query<RunOwnership & { has_timer: boolean } & Partial<RevisedRow>>(
    `select r.delivered_by_account_id, r.run_state, t.run_id is not null as has_timer,
            ${TIMER_COLUMNS}
       from pilot.session_script_runs r
       left join pilot.round_timers t on t.organization_id = r.organization_id and t.run_id = r.run_id
      where r.organization_id = $1 and r.run_id = $2`,
    [organizationId, runId],
  );
  assertOwnLiveRun(rows[0], accountId);
  return rows[0].has_timer ? revised(rows[0] as RevisedRow) : null;
}
