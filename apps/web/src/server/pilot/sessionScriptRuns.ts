import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

// The delivery side of a session script. sessionScripts.ts reads the plan; this module writes what
// is happening to it right now, into pilot.session_script_runs.
//
// Columns owned by infra/azure/pilot_slice_postgres_session_run_state_migration.sql. Nothing here
// issues DDL.
//
// THE SERVER OWNS THE CLOCK. Callers never send elapsed time and this module never trusts one.
// elapsed_seconds is computed from started_at, paused_seconds and (while paused) paused_at, so a
// phone that slept through half the class resumes to the same reading as one that stayed awake.
// This is the whole reason a live run is a row rather than React state.
//
// TWO INVARIANTS THE DATABASE CANNOT HOLD, enforced here and covered by their own tests:
//   1. The cursor must belong to THIS RUN'S script. The FK only proves the block exists somewhere
//      in the organization, because a check constraint cannot reach another table -- so without
//      this, block 3 of Tuesday's plan could be set as the cursor of Wednesday's session.
//   2. Only the coach delivering a run may move it. Two coaches on the same floor hold two
//      different runs, and neither should be able to advance the other's room.
//
// A settled run is immutable through this module. Reopening a finished session would let a coach
// rewrite the record of a night that already happened, which is exactly the separation the
// migration's comment about not overwriting the plan exists to protect.

export type SessionScriptRunState = 'in_progress' | 'completed' | 'abandoned';

const TERMINAL_STATES: readonly SessionScriptRunState[] = ['completed', 'abandoned'];

export interface SessionScriptRunRow {
  organization_id: string;
  run_id: string;
  script_id: string;
  script_version: number;
  activity_id: string | null;
  delivered_by_account_id: string;
  delivered_on: string;
  athletes_present: number | null;
  blocks_completed: number | null;
  reset_protocol_used: boolean;
  deviation_note: string;
  what_worked: string;
  what_did_not: string;
  created_at: string;
  // Added by the run-state migration. Null on rows that predate live-run tracking.
  run_state: SessionScriptRunState | null;
  started_at: string | null;
  ended_at: string | null;
  current_block_id: string | null;
  paused_at: string | null;
  paused_seconds: number | null;
}

// What a live run looks like to a caller: the stored row plus the two things only the server can
// say truthfully -- how long the session has been running, and whether it is paused right now.
export interface LiveSessionScriptRun extends SessionScriptRunRow {
  run_state: 'in_progress';
  started_at: string;
  elapsed_seconds: number;
  is_paused: boolean;
}

export class SessionScriptRunError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'SessionScriptRunError';
    this.status = status;
  }
}

const RUN_COLUMNS = `
  organization_id, run_id, script_id, script_version, activity_id,
  delivered_by_account_id, delivered_on, athletes_present, blocks_completed,
  reset_protocol_used, deviation_note, what_worked, what_did_not, created_at,
  run_state, started_at, ended_at, current_block_id, paused_at, paused_seconds
`;

// Elapsed is derived, never stored: storing it would go stale the moment nobody was writing.
// While paused, the clock is frozen at the moment the pause began rather than continuing to run.
function computeElapsedSeconds(row: SessionScriptRunRow, now: Date): number {
  if (!row.started_at) return 0;
  const started = new Date(row.started_at).getTime();
  const reference = row.paused_at ? new Date(row.paused_at).getTime() : now.getTime();
  const grossSeconds = Math.max(0, Math.floor((reference - started) / 1000));
  return Math.max(0, grossSeconds - (row.paused_seconds ?? 0));
}

function toLiveRun(row: SessionScriptRunRow, now: Date = new Date()): LiveSessionScriptRun {
  if (row.run_state !== 'in_progress' || !row.started_at) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
  return {
    ...row,
    run_state: 'in_progress',
    started_at: row.started_at,
    elapsed_seconds: computeElapsedSeconds(row, now),
    is_paused: row.paused_at !== null,
  };
}

// The resume lookup. pilot_ssrun_one_live_per_coach makes this at most one row, which is why
// resume can answer definitively instead of picking between candidates.
export async function getLiveRunForCoach(
  organizationId: string,
  accountId: string,
): Promise<LiveSessionScriptRun | null> {
  const row = await queryOne<SessionScriptRunRow>(
    `select ${RUN_COLUMNS}
       from pilot.session_script_runs
      where organization_id = $1
        and delivered_by_account_id = $2
        and run_state = 'in_progress'`,
    [organizationId, accountId],
  );
  return row ? toLiveRun(row) : null;
}

async function requireOwnLiveRun(
  organizationId: string,
  accountId: string,
  runId: string,
): Promise<SessionScriptRunRow> {
  const row = await queryOne<SessionScriptRunRow>(
    `select ${RUN_COLUMNS}
       from pilot.session_script_runs
      where organization_id = $1 and run_id = $2`,
    [organizationId, runId],
  );

  if (!row) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_FOUND', 404);
  }
  // Invariant 2. Deliberately the same code and status as a missing run: a coach probing another
  // coach's run id should not be able to tell "exists but not yours" from "does not exist".
  if (row.delivered_by_account_id !== accountId) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_FOUND', 404);
  }
  if (row.run_state !== 'in_progress') {
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
  return row;
}

// Invariant 1. The FK proves the block exists in the organization; only this proves it belongs to
// the script being delivered.
async function assertBlockBelongsToScript(
  organizationId: string,
  scriptId: string,
  blockId: string,
): Promise<void> {
  const block = await queryOne<{ block_id: string }>(
    `select block_id
       from pilot.session_script_blocks
      where organization_id = $1 and script_id = $2 and block_id = $3`,
    [organizationId, scriptId, blockId],
  );
  if (!block) {
    throw new SessionScriptRunError('SESSION_RUN_BLOCK_NOT_IN_SCRIPT', 422);
  }
}

export interface StartSessionScriptRunInput {
  scriptId: string;
  activityId?: string | null;
  athletesPresent?: number | null;
  deliveredOn?: string;
}

// Starting a run pins the script's CURRENT version onto the row. A script edited mid-season must
// not retroactively change what a coach was following on a night already delivered.
export async function startSessionScriptRun(
  organizationId: string,
  accountId: string,
  input: StartSessionScriptRunInput,
): Promise<LiveSessionScriptRun> {
  return withTransaction(async (client) => {
    const script = await client.query<{ script_id: string; version: number }>(
      `select script_id, version
         from pilot.session_scripts
        where organization_id = $1 and script_id = $2`,
      [organizationId, input.scriptId],
    );
    if (script.rowCount === 0) {
      throw new SessionScriptRunError('SESSION_SCRIPT_NOT_FOUND', 404);
    }

    // The cursor opens on the first block in running order. A live run with a null cursor would
    // render as a session on no block at all.
    const firstBlock = await client.query<{ block_id: string }>(
      `select block_id
         from pilot.session_script_blocks
        where organization_id = $1 and script_id = $2
        order by block_order asc
        limit 1`,
      [organizationId, input.scriptId],
    );
    // A script with no blocks cannot be run. This is the state the seed blocker leaves scripts in,
    // so it fails with a nameable reason rather than a null cursor a coach has to interpret.
    if (firstBlock.rowCount === 0) {
      throw new SessionScriptRunError('SESSION_SCRIPT_HAS_NO_BLOCKS', 422);
    }

    const runId = `ssrun_${Date.now()}_${randomUUID().substring(0, 8)}`;

    let inserted;
    try {
      inserted = await client.query<SessionScriptRunRow>(
        `insert into pilot.session_script_runs (
           organization_id, run_id, script_id, script_version, activity_id,
           delivered_by_account_id, delivered_on, athletes_present,
           run_state, started_at, current_block_id, paused_seconds
         ) values (
           $1, $2, $3, $4, $5,
           $6, coalesce($7::date, current_date), $8,
           'in_progress', now(), $9, 0
         )
         returning ${RUN_COLUMNS}`,
        [
          organizationId,
          runId,
          input.scriptId,
          script.rows[0].version,
          input.activityId ?? null,
          accountId,
          input.deliveredOn ?? null,
          input.athletesPresent ?? null,
          firstBlock.rows[0].block_id,
        ],
      );
    } catch (error) {
      // pilot_ssrun_one_live_per_coach. A double-tapped start button is the common cause, so this
      // reads as "you already have one" rather than as a database error.
      if ((error as { constraint?: string }).constraint === 'pilot_ssrun_one_live_per_coach') {
        throw new SessionScriptRunError('SESSION_RUN_ALREADY_LIVE', 409);
      }
      throw error;
    }

    return toLiveRun(inserted.rows[0]);
  });
}

// Moving the cursor. Deliberately takes a target block rather than "next": a coach who skips a
// block or goes back to re-teach one is doing something normal, and an increment-only API would
// force the client to model an order it does not own.
export async function moveSessionScriptRunCursor(
  organizationId: string,
  accountId: string,
  runId: string,
  toBlockId: string,
): Promise<LiveSessionScriptRun> {
  const run = await requireOwnLiveRun(organizationId, accountId, runId);
  await assertBlockBelongsToScript(organizationId, run.script_id, toBlockId);

  const rows = await query<SessionScriptRunRow>(
    `update pilot.session_script_runs
        set current_block_id = $3
      where organization_id = $1 and run_id = $2 and run_state = 'in_progress'
      returning ${RUN_COLUMNS}`,
    [organizationId, runId, toBlockId],
  );
  if (rows.length === 0) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
  return toLiveRun(rows[0]);
}

export async function pauseSessionScriptRun(
  organizationId: string,
  accountId: string,
  runId: string,
): Promise<LiveSessionScriptRun> {
  // Ownership and liveness still need the read -- 404-vs-409 cannot be decided from an UPDATE that
  // matched nothing. But the pause itself must NOT depend on what that read saw.
  await requireOwnLiveRun(organizationId, accountId, runId);

  // IDEMPOTENT IN ONE STATEMENT. The previous version read paused_at, branched on it, then ran an
  // UPDATE conditioned on `paused_at is null`. Two overlapping pauses -- a double tap, or a retried
  // request -- both read null, the first won, and the second matched no row and returned
  // SESSION_RUN_NOT_LIVE for a run that was live and had reached the state the caller asked for.
  // `coalesce(paused_at, now())` needs no such condition: an already-paused run keeps the pause it
  // has, so both callers succeed and neither loses the seconds already banked.
  const rows = await query<SessionScriptRunRow>(
    `update pilot.session_script_runs
        set paused_at = coalesce(paused_at, now())
      where organization_id = $1 and run_id = $2
        and run_state = 'in_progress'
      returning ${RUN_COLUMNS}`,
    [organizationId, runId],
  );
  if (rows.length === 0) {
    // Only reachable if the run settled between the read and this update, which is a real 409.
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
  return toLiveRun(rows[0]);
}

export async function resumeSessionScriptRun(
  organizationId: string,
  accountId: string,
  runId: string,
): Promise<LiveSessionScriptRun> {
  await requireOwnLiveRun(organizationId, accountId, runId);

  // Same race as pause, same shape of fix: no `paused_at is not null` condition, so two overlapping
  // resumes both match and both succeed. The `case` makes it a no-op on an already-running run
  // rather than adding a second interval, and the pause is closed out from the DATABASE's clock so
  // the banked total never depends on the caller's sense of time.
  const rows = await query<SessionScriptRunRow>(
    `update pilot.session_script_runs
        set paused_seconds = coalesce(paused_seconds, 0)
                             + case
                                 when paused_at is not null
                                   then greatest(0, floor(extract(epoch from (now() - paused_at)))::integer)
                                 else 0
                               end,
            paused_at = null
      where organization_id = $1 and run_id = $2
        and run_state = 'in_progress'
      returning ${RUN_COLUMNS}`,
    [organizationId, runId],
  );
  if (rows.length === 0) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
  return toLiveRun(rows[0]);
}

export interface FinishSessionScriptRunInput {
  runState: 'completed' | 'abandoned';
  blocksCompleted?: number | null;
  athletesPresent?: number | null;
  resetProtocolUsed?: boolean;
  deviationNote?: string;
  whatWorked?: string;
  whatDidNot?: string;
}

// Finishing settles the row. An OPEN pause is banked into paused_seconds first -- dropping it
// would make every later reading of actual teaching time overcount by the final pause -- and only
// then is the cursor and paused_at cleared, because neither is meaningful once the room has emptied
// and pilot_ssrun_pause_only_live would reject a paused settled run anyway. Clearing run_state's live value also releases the one-live-per-coach index so the coach
// can start their next class.
export async function finishSessionScriptRun(
  organizationId: string,
  accountId: string,
  runId: string,
  input: FinishSessionScriptRunInput,
): Promise<SessionScriptRunRow> {
  if (!TERMINAL_STATES.includes(input.runState)) {
    throw new SessionScriptRunError('SESSION_RUN_STATE_INVALID', 422);
  }
  await requireOwnLiveRun(organizationId, accountId, runId);

  const rows = await query<SessionScriptRunRow>(
    `update pilot.session_script_runs
        set run_state = $3,
            ended_at = now(),
            current_block_id = null,
            -- Bank the OPEN pause before discarding it. A coach who pauses and then ends the
            -- session without resuming would otherwise lose that final interval, and every later
            -- reading of actual teaching time (ended_at - started_at - paused_seconds) would
            -- overcount by exactly the length of the last pause.
            paused_seconds = coalesce(paused_seconds, 0)
                             + case
                                 when paused_at is not null
                                   then greatest(0, floor(extract(epoch from (now() - paused_at)))::integer)
                                 else 0
                               end,
            paused_at = null,
            blocks_completed = coalesce($4, blocks_completed),
            athletes_present = coalesce($5, athletes_present),
            reset_protocol_used = coalesce($6, reset_protocol_used),
            deviation_note = coalesce($7, deviation_note),
            what_worked = coalesce($8, what_worked),
            what_did_not = coalesce($9, what_did_not)
      where organization_id = $1 and run_id = $2 and run_state = 'in_progress'
      returning ${RUN_COLUMNS}`,
    [
      organizationId,
      runId,
      input.runState,
      input.blocksCompleted ?? null,
      input.athletesPresent ?? null,
      input.resetProtocolUsed ?? null,
      input.deviationNote ?? null,
      input.whatWorked ?? null,
      input.whatDidNot ?? null,
    ],
  );
  if (rows.length === 0) {
    throw new SessionScriptRunError('SESSION_RUN_NOT_LIVE', 409);
  }
  return rows[0];
}

// History for a script. Excludes live runs: a session still on the floor is not yet a record of
// what happened, and mixing the two is how a half-finished night gets counted as a delivery.
export async function listSettledRunsForScript(
  organizationId: string,
  scriptId: string,
  limit = 50,
): Promise<SessionScriptRunRow[]> {
  return query<SessionScriptRunRow>(
    `select ${RUN_COLUMNS}
       from pilot.session_script_runs
      where organization_id = $1
        and script_id = $2
        and (run_state is null or run_state in ('completed', 'abandoned'))
      order by delivered_on desc, created_at desc
      limit $3`,
    [organizationId, scriptId, limit],
  );
}

export const __testables = { computeElapsedSeconds };
