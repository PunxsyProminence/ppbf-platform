import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

// The delivery side of a session script. sessionScripts.ts reads the plan; this module writes what
// is happening to it right now, into pilot.session_script_runs.
//
// Columns owned by infra/azure/pilot_slice_postgres_session_run_state_migration.sql and (show_on_wall)
// pilot_slice_postgres_session_run_show_on_wall_migration.sql. Nothing here issues DDL.
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
  // NULL together on a plain session (issue #1523; pilot_ssrun_script_pair).
  script_id: string | null;
  script_version: number | null;
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
  // Added by the show-on-wall migration. False on every row until the delivering coach turns it
  // on, and only ever true on a live run (pilot_ssrun_wall_only_live).
  show_on_wall: boolean;
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
  run_state, started_at, ended_at, current_block_id, paused_at, paused_seconds, show_on_wall
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

// A FORGOTTEN LIVE SESSION CLOSES ITSELF. OD-2026-10-21-001 ruling 2 (pilot decision D2), Jason:
// "A: Yes, after 3 hours (Rec.)", whose option text reads "If a coach forgets to end class, the app
// ends it 3 hours after the last activity": closed as ABANDONED and taken off the TV. Found live on
// 2026-10-19: a coach's plain session sat in_progress for 29h 33m, still set to show on the gym
// TV, until it was ended by hand.
//
// IDLE means nothing about the run was SAVED for three hours. The signals are the timestamps that
// already exist; nothing here adds a column:
//   started_at and paused_at on the run itself;
//   started_at + paused_seconds, a lower bound on the last resume (a resume clears paused_at but
//     banks the pause, and the pause cannot have begun before the start);
//   a presence mark made or taken back (pilot.session_run_athletes marked_at / removed_at);
//   any change to the run's round clock (pilot.round_timers created_at / updated_at);
//   a staff note on the run (pilot.session_staff_notes created_at / updated_at);
//   an intervention logged against the run (pilot.intervention_executions session_run_id,
//     created_at / updated_at);
//   a behaviour report filed under the run (pilot.behaviour_observations session_key
//     'run:<run_id>', observed_at / created_at).
// NOT SEEN: moving the block cursor, a resume after the lower bound above, and the Show on TV
// switch write no timestamp, so a session driven only by those for three hours reads as idle.
// Linking a run to a development block or objective is done after a run settles, so it is not a
// live signal. A TV polling or a screen left open is not activity either: that is exactly the
// forgotten case. Hence the note says "no recorded activity", not "no activity".
//
// THE RECORD. The run settles as 'abandoned' exactly as a coach's own Abandon would (cursor and
// pause cleared, an open pause banked, off the TV), with two differences: ended_at is the moment
// the limit was reached (last activity + 3 hours), not the moment a sweep happened to notice, so
// the history reads the same whenever the sweep ran (the athlete check-in auto-close does the same,
// sessionAutoClose.ts); and the deviation note says the app closed it, so "Abandoned" is never
// read as something the coach chose.
//
// WHEN IT RUNS. Lazily, before every read that could show a live run: the coach's own live lookup,
// a start (so a forgotten run does not hold the one-live-per-coach slot), the two history reads,
// and in gymTvs.ts the paired TV's read, the Paired TVs list and a send to a TV. Dropping it from
// the TV needs nothing more: the TV only honours a run that is in_progress and shown
// (LIVE_SHOWN_RUN), so a settled run reads as "nothing on this TV". One statement per
// organization; it never touches a settled run.
export const SESSION_RUN_IDLE_LIMIT_SECONDS = 3 * 60 * 60;
// PROPOSED copy (new words; Jason has not seen them).
export const SESSION_RUN_IDLE_CLOSE_NOTE = 'Closed automatically after 3 hours with no recorded activity.';

interface ActivitySources {
  marks: boolean;
  timer: boolean;
  notes: boolean;
  interventions: boolean;
  behaviour: boolean;
}

// Which of the side tables this database has. The live read and the TV must never fail because a
// later migration is not applied where they run, so a missing table drops its signal instead of
// breaking the statement. Cached only once all are present (tables are never dropped); asked again
// while any is missing, so an environment that applies the migration picks it up.
let activitySourcesCache: ActivitySources | null = null;

async function readActivitySources(): Promise<ActivitySources> {
  if (activitySourcesCache) return activitySourcesCache;
  const row = await queryOne<{ [K in keyof ActivitySources]: boolean }>(
    `select to_regclass('pilot.session_run_athletes') is not null as marks,
            to_regclass('pilot.round_timers') is not null as timer,
            exists (select 1 from pg_attribute
                     where attrelid = to_regclass('pilot.session_staff_notes')
                       and attname = 'run_id' and not attisdropped) as notes,
            exists (select 1 from pg_attribute
                     where attrelid = to_regclass('pilot.intervention_executions')
                       and attname = 'session_run_id' and not attisdropped) as interventions,
            exists (select 1 from pg_attribute
                     where attrelid = to_regclass('pilot.behaviour_observations')
                       and attname = 'session_key' and not attisdropped) as behaviour`,
  );
  const sources: ActivitySources = {
    marks: row?.marks === true,
    timer: row?.timer === true,
    notes: row?.notes === true,
    interventions: row?.interventions === true,
    behaviour: row?.behaviour === true,
  };
  if (Object.values(sources).every(Boolean)) activitySourcesCache = sources;
  return sources;
}

// $2 is "now". least() caps a future-dated stamp at now, so a run is never closed on a clock that
// says something happened later than the sweep (sessionAutoClose.ts does the same). Every subquery
// yields one timestamp; nothing else is read from these tables.
const RUN_ROW_SIGNALS = [
  'r.started_at',
  'r.paused_at',
  'r.started_at + make_interval(secs => coalesce(r.paused_seconds, 0))',
];

function lastActivitySql(sources: ActivitySources): string {
  const signals = [...RUN_ROW_SIGNALS];
  if (sources.marks) {
    signals.push(`(select max(greatest(m.marked_at, m.removed_at)) from pilot.session_run_athletes m
                    where m.organization_id = r.organization_id and m.run_id = r.run_id)`);
  }
  if (sources.timer) {
    signals.push(`(select greatest(t.created_at, t.updated_at) from pilot.round_timers t
                    where t.organization_id = r.organization_id and t.run_id = r.run_id)`);
  }
  if (sources.notes) {
    signals.push(`(select max(greatest(n.created_at, n.updated_at)) from pilot.session_staff_notes n
                    where n.organization_id = r.organization_id and n.run_id = r.run_id)`);
  }
  if (sources.interventions) {
    signals.push(`(select max(greatest(x.created_at, x.updated_at)) from pilot.intervention_executions x
                    where x.organization_id = r.organization_id and x.session_run_id = r.run_id)`);
  }
  if (sources.behaviour) {
    signals.push(`(select max(greatest(b.observed_at, b.created_at)) from pilot.behaviour_observations b
                    where b.organization_id = r.organization_id and b.session_key = 'run:' || r.run_id)`);
  }
  return `least($2::timestamptz, greatest(${signals.join(', ')}))`;
}

/**
 * Settles every live run of this organization that has been idle for the limit, as 'abandoned'.
 * Returns the run ids it closed. Throws on a database error; readers call sweepIdleRuns instead.
 */
export async function closeIdleSessionRuns(
  organizationId: string,
  options: { now?: Date; idleLimitSeconds?: number } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const limit = options.idleLimitSeconds ?? SESSION_RUN_IDLE_LIMIT_SECONDS;
  const sources = await readActivitySources();
  const rows = await query<{ run_id: string }>(
    `with idle as (
       select r.organization_id, r.run_id, ${lastActivitySql(sources)} as last_activity_at
         from pilot.session_script_runs r
        where r.organization_id = $1
          and r.run_state = 'in_progress'
          and r.started_at is not null
     )
     update pilot.session_script_runs r
        set run_state = 'abandoned',
            ended_at = i.last_activity_at + make_interval(secs => $3::integer),
            current_block_id = null,
            paused_seconds = coalesce(r.paused_seconds, 0)
                             + case
                                 when r.paused_at is not null
                                   then greatest(0, floor(extract(epoch from (
                                          i.last_activity_at + make_interval(secs => $3::integer) - r.paused_at
                                        )))::integer)
                                 else 0
                               end,
            paused_at = null,
            show_on_wall = false,
            deviation_note = case
                               when btrim(r.deviation_note) = '' then $4::text
                               else r.deviation_note || E'\\n' || $4::text
                             end
       from idle i
      where r.organization_id = i.organization_id
        and r.run_id = i.run_id
        -- Re-read under the row lock: a coach's own finish that committed first wins, and so does a
        -- pause or resume (the run's own signals are asked again of the locked row, not only of the
        -- statement's snapshot above).
        and r.run_state = 'in_progress'
        and least($2::timestamptz, greatest(${RUN_ROW_SIGNALS.join(', ')}))
              <= $2::timestamptz - make_interval(secs => $3::integer)
        and i.last_activity_at <= $2::timestamptz - make_interval(secs => $3::integer)
      returning r.run_id`,
    [organizationId, now, limit, SESSION_RUN_IDLE_CLOSE_NOTE],
  );
  return rows.map((row) => row.run_id);
}

// The readers' form. A sweep that fails must not take the coach's screen or the TV down with it:
// the read goes ahead and the next read tries again. Logged by error class and SQLSTATE only, and
// at most once a minute per process: a TV polls every few seconds.
const SWEEP_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastSweepFailureLogMs = 0;

export async function sweepIdleRuns(organizationId: string): Promise<void> {
  try {
    await closeIdleSessionRuns(organizationId);
  } catch (error) {
    const nowMs = Date.now();
    if (nowMs - lastSweepFailureLogMs < SWEEP_FAILURE_LOG_INTERVAL_MS) return;
    lastSweepFailureLogMs = nowMs;
    const code = (error as { code?: unknown })?.code;
    console.error('session-run-idle-close-failed', {
      name: error instanceof Error ? error.constructor.name : typeof error,
      code: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
    });
  }
}

// The resume lookup. pilot_ssrun_one_live_per_coach makes this at most one row, which is why
// resume can answer definitively instead of picking between candidates.
export async function getLiveRunForCoach(
  organizationId: string,
  accountId: string,
): Promise<LiveSessionScriptRun | null> {
  await sweepIdleRuns(organizationId);
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
  // Absent or null starts a PLAIN session (Jason 2026-10-12, issue #1523: "allow a plain
  // session"): no script, no blocks, no cursor -- the clock, pause, TV and finish only.
  scriptId?: string | null;
  activityId?: string | null;
  athletesPresent?: number | null;
  deliveredOn?: string;
}

// Starting a run pins the script's CURRENT version onto the row. A script edited mid-season must
// not retroactively change what a coach was following on a night already delivered.
//
// ONLY THE HEAD VERSION CAN BE STARTED. A revision is a new row in the same lineage
// (session_scripts migration :59), so a script_id can name a plan that has since been replaced --
// from a list loaded before the revision, or an old link. Starting it would run tonight's session
// from the superseded plan. "Superseded" is derived exactly as listSessionScripts derives it (a
// higher version exists in the lineage), so the list and this refusal cannot disagree.
//
// THE SCRIPT ROW IS SHARE-LOCKED FIRST, and "is it the head" is asked in a statement of its own
// after the lock is held. A coach's edit (sessionScriptAuthoring.ts) and a content import both hold
// that row FOR UPDATE while they write the next version. Asked unlocked, or in the locking
// statement itself, the question was answered from before the wait: the start saw v1 as the head,
// its insert queued behind the edit, and it then committed a run on the version just replaced
// (Codex on #1560). A share lock lets any number of coaches start the same plan at once; it only
// waits for a writer of the next version, and makes that writer wait for this start.
//
// This is a START check only. A run already live on the older version keeps its pinned script_id
// and script_version: cursor, pause, resume and finish below never consult the lineage, because
// the coach on the floor is mid-session on the plan they started, and switching plans under them
// would be the retroactive rewrite this pinning exists to prevent.
export async function startSessionScriptRun(
  organizationId: string,
  accountId: string,
  input: StartSessionScriptRunInput,
): Promise<LiveSessionScriptRun> {
  // A forgotten run must not hold this coach's one live slot (SESSION_RUN_ALREADY_LIVE).
  await sweepIdleRuns(organizationId);
  if (!input.scriptId) {
    return startPlainRun(organizationId, accountId, input);
  }
  const scriptId = input.scriptId;
  return withTransaction(async (client) => {
    const script = await client.query<{ script_id: string; version: number; lineage_id: string }>(
      `select script_id, version, lineage_id
         from pilot.session_scripts
        where organization_id = $1 and script_id = $2
          for share`,
      [organizationId, scriptId],
    );
    if (script.rowCount === 0) {
      throw new SessionScriptRunError('SESSION_SCRIPT_NOT_FOUND', 404);
    }
    const newer = await client.query(
      `select 1
         from pilot.session_scripts
        where organization_id = $1 and lineage_id = $2 and version > $3
        limit 1`,
      [organizationId, script.rows[0].lineage_id, script.rows[0].version],
    );
    // 409, not 404: the script exists and is readable, it is just no longer the one to run. Checked
    // before the blocks, because the remedy (start the newer version) is the same either way.
    if ((newer.rowCount ?? 0) > 0) {
      throw new SessionScriptRunError('SESSION_SCRIPT_SUPERSEDED', 409);
    }

    // The cursor opens on the first block in running order. A live run with a null cursor would
    // render as a session on no block at all.
    const firstBlock = await client.query<{ block_id: string }>(
      `select block_id
         from pilot.session_script_blocks
        where organization_id = $1 and script_id = $2
        order by block_order asc
        limit 1`,
      [organizationId, scriptId],
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
          scriptId,
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

// A plain session (issue #1523): the same live run as a scripted one -- one per coach, paused,
// shown on the TV and finished through the same functions -- with no script, no version and no
// block cursor (pilot_ssrun_plain_no_cursor). Nothing about the athletes changes: who may read
// whom is the roster's and the routes' business, not the run's.
async function startPlainRun(
  organizationId: string,
  accountId: string,
  input: StartSessionScriptRunInput,
): Promise<LiveSessionScriptRun> {
  const runId = `ssrun_${Date.now()}_${randomUUID().substring(0, 8)}`;
  try {
    const rows = await query<SessionScriptRunRow>(
      `insert into pilot.session_script_runs (
         organization_id, run_id, script_id, script_version, activity_id,
         delivered_by_account_id, delivered_on, athletes_present,
         run_state, started_at, current_block_id, paused_seconds
       ) values (
         $1, $2, null, null, $3,
         $4, coalesce($5::date, current_date), $6,
         'in_progress', now(), null, 0
       )
       returning ${RUN_COLUMNS}`,
      [
        organizationId,
        runId,
        input.activityId ?? null,
        accountId,
        input.deliveredOn ?? null,
        input.athletesPresent ?? null,
      ],
    );
    return toLiveRun(rows[0]);
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'pilot_ssrun_one_live_per_coach') {
      throw new SessionScriptRunError('SESSION_RUN_ALREADY_LIVE', 409);
    }
    throw error;
  }
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
  // A plain session has no blocks to move between.
  if (!run.script_id) {
    throw new SessionScriptRunError('SESSION_RUN_HAS_NO_SCRIPT', 409);
  }
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

// The coach's "Show on TV" switch (show-on-wall migration). Only the delivering coach can flip it,
// and only on a live run: requireOwnLiveRun gives another coach's run the same 404 as a missing one,
// exactly as for the cursor. Setting it to the value it already has succeeds -- a double tap, or a
// retried request after a dropped response, reaches the state the coach asked for.
//
// The live-run condition sits in the UPDATE as well as in the read, so a run that settles between
// the two is refused with 409 rather than having the switch written onto a finished session (which
// pilot_ssrun_wall_only_live would also refuse, as a database error instead of a nameable one).
export async function setSessionScriptRunShowOnWall(
  organizationId: string,
  accountId: string,
  runId: string,
  showOnWall: boolean,
): Promise<LiveSessionScriptRun> {
  await requireOwnLiveRun(organizationId, accountId, runId);

  const rows = await query<SessionScriptRunRow>(
    `update pilot.session_script_runs
        set show_on_wall = $4
      where organization_id = $1 and run_id = $2
        and delivered_by_account_id = $3
        and run_state = 'in_progress'
      returning ${RUN_COLUMNS}`,
    [organizationId, runId, accountId, showOnWall],
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
            -- Off the TV in the same statement that settles the run. pilot_ssrun_wall_only_live
            -- would refuse a settled run left showing, and the wall must never present a finished
            -- session as the one on the floor now.
            show_on_wall = false,
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
//
// The history is the whole LINEAGE's, not just this version's. The browse list shows only the head
// (sessionScripts.ts listSessionScripts), and this read is reached only from a plan opened there
// (coach/session-scripts/page.tsx loadDeliveries). Reading by exact script_id would drop every
// night delivered from v1 off the screen the moment v2 loaded. Each row still carries its own
// script_version, which the page prints, so versions stay told apart. The lineage is resolved
// inside the caller's organization, so another gym's same-id lineage never adds rows.
export async function listSettledRunsForScript(
  organizationId: string,
  scriptId: string,
  limit = 50,
): Promise<SessionScriptRunRow[]> {
  await sweepIdleRuns(organizationId);
  return query<SessionScriptRunRow>(
    `select ${RUN_COLUMNS}
       from pilot.session_script_runs
      where organization_id = $1
        and script_id in (
          select version_row.script_id
            from pilot.session_scripts requested
            join pilot.session_scripts version_row
              on version_row.organization_id = requested.organization_id
             and version_row.lineage_id = requested.lineage_id
           where requested.organization_id = $1
             and requested.script_id = $2
        )
        and (run_state is null or run_state in ('completed', 'abandoned'))
      order by delivered_on desc, created_at desc
      limit $3`,
    [organizationId, scriptId, limit],
  );
}

// The same columns qualified to the run alias, for the read below that joins the script.
const RUN_COLUMNS_QUALIFIED = RUN_COLUMNS.split(',').map((column) => `r.${column.trim()}`).join(', ');

/** A settled run with the name of the plan it was delivered from (null for a plain session). */
export interface SettledSessionRun extends SessionScriptRunRow {
  script_name: string | null;
}

// The gym's finished sessions, newest first: plain and scripted alike (audit finding F-067).
//
// listSettledRunsForScript above is reached from an open plan, so a PLAIN session -- which has no
// plan -- could never be read back once it ended, and its end notes with it. This read is by
// organization instead. It carries the coach's own end notes (deviation_note, what_worked,
// what_did_not), which are staff text: the routes that call it admit coach and organization admin
// only. WHO WAS PRESENT is not here; that is sessionRunAthletes.ts, which filters by the athletes
// the reader may reach.
//
// Live runs are left out for the reason given above: a session still on the floor is not yet a
// record. Legacy rows with no run_state are left out too; they predate live delivery and are
// reached through their plan.
export async function listSettledRunsForOrganization(
  organizationId: string,
  limit = 50,
): Promise<SettledSessionRun[]> {
  await sweepIdleRuns(organizationId);
  return query<SettledSessionRun>(
    `select ${RUN_COLUMNS_QUALIFIED}, s.name as script_name
       from pilot.session_script_runs r
       left join pilot.session_scripts s
         on s.organization_id = r.organization_id and s.script_id = r.script_id
      where r.organization_id = $1
        and r.run_state in ('completed', 'abandoned')
      order by r.ended_at desc nulls last, r.created_at desc, r.run_id
      limit $2`,
    [organizationId, limit],
  );
}

export const __testables = { computeElapsedSeconds };
