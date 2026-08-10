-- Session run state — the difference between a session that HAPPENED and one HAPPENING NOW
--
-- WHY THIS EXISTS. pilot.session_script_runs already records what happened on a given night:
-- how many were present, how many blocks got done, what worked, what did not. Every one of those
-- fields is something a coach knows only once the session is over. The table can describe a
-- finished session and cannot describe a session in progress -- there is no start time, no cursor
-- saying which block the room is on, and no way to tell a live run from a settled record.
--
-- That gap is what makes the coach floor surface impossible rather than merely unbuilt. A coach
-- running a class from a phone who locks the screen, takes a call, or reloads the page has no
-- row to come back to, so the session exists only in the browser tab holding it. This migration
-- gives a run a lifecycle, so the server owns the clock and the cursor and the tab owns neither.
--
-- EVERY NEW COLUMN IS NULLABLE WITH NO BACKFILL, and run_state has no default. A row written
-- before this migration is a post-hoc record of a session nobody timed: it has no knowable
-- started_at, and no honest run_state either. Defaulting such a row to 'completed' would invent
-- an observation, and defaulting it to 'in_progress' would claim a class from months ago is
-- still on the floor. Null reads as "this row predates live-run tracking", which is the only
-- true thing available. New rows always set run_state explicitly; the constraints below make a
-- half-populated live run impossible rather than merely discouraged.
--
-- THE SERVER OWNS THE CLOCK. started_at and paused_seconds are the whole timer: elapsed is
-- now() - started_at - paused_seconds, computed from stored values rather than from anything the
-- client counted. A browser tab that was asleep for twenty minutes and one that was watched the
-- whole time resume to the same reading, which is the entire point of persisting this at all.
--
-- ONE LIVE RUN PER COACH, ENFORCED BY THE DATABASE. The partial unique index below is not a
-- convenience -- it is what makes "resume my session" a single lookup with exactly one answer.
-- Without it, a double-tapped start button leaves two live runs and the resume path has to guess
-- which one the coach meant.
--
-- DEPENDS ON pilot.session_script_runs and pilot.session_script_blocks, both from
-- pilot_slice_postgres_session_scripts_migration.sql. No begin;/commit; here on purpose, matching
-- this repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-session-run-state-migration.mjs).

alter table pilot.session_script_runs
  add column if not exists run_state text null,
  add column if not exists started_at timestamptz null,
  add column if not exists ended_at timestamptz null,
  add column if not exists current_block_id text null,
  add column if not exists paused_at timestamptz null,
  add column if not exists paused_seconds integer null;

comment on column pilot.session_script_runs.run_state is
  'in_progress | completed | abandoned. NULL means the row predates live-run tracking and was recorded after the fact; it is not a live run.';
comment on column pilot.session_script_runs.started_at is
  'When the coach started the session. The timer is derived from this server-side; the client never supplies elapsed time.';
comment on column pilot.session_script_runs.current_block_id is
  'Which block the room is on. NULL on a settled run -- the cursor is only meaningful while in_progress.';
comment on column pilot.session_script_runs.paused_at is
  'Set while a live run is paused, NULL while it is running. Only ever non-null on an in_progress run.';
comment on column pilot.session_script_runs.paused_seconds is
  'Accumulated paused time, closed out each time a pause ends. Distinct from NULL: 0 means a run that genuinely never paused.';

-- The vocabulary. Null is admitted deliberately (see header) rather than by omission.
alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_state_vocab;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_state_vocab check (
    run_state is null or run_state in ('in_progress', 'completed', 'abandoned')
  );

-- A live run has started and has not ended. A settled run has ended. Neither state is
-- expressible half-way, so a crashed writer cannot leave a row that reads as both.
alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_state_times;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_state_times check (
    run_state is null
    or (run_state = 'in_progress' and started_at is not null and ended_at is null)
    or (run_state in ('completed', 'abandoned') and started_at is not null and ended_at is not null)
  );

-- Time cannot run backwards.
alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_end_after_start;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_end_after_start check (
    ended_at is null or started_at is null or ended_at >= started_at
  );

-- Paused is a property of a live run. A finished session is not "paused", it is over, and a row
-- claiming both is the shape a stuck timer would take.
alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_pause_only_live;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_pause_only_live check (
    paused_at is null or run_state = 'in_progress'
  );

alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_paused_seconds_sane;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_paused_seconds_sane check (
    paused_seconds is null or paused_seconds >= 0
  );

-- The cursor must EXIST while the room is live and must be gone once it is not. Without this the
-- header's claim that these constraints make a half-populated live run impossible was an overclaim:
-- a buggy write path or a manual fixup could leave an in_progress run with a null cursor (a session
-- on no block at all) or a completed run still pointing at one, and every reader treats the cursor
-- as meaningful only while in_progress. Legacy rows are exempt via the null run_state branch, the
-- same way every other constraint here exempts them.
alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_cursor_matches_state;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_cursor_matches_state check (
    run_state is null
    or (run_state = 'in_progress' and current_block_id is not null)
    or (run_state in ('completed', 'abandoned') and current_block_id is null)
  );

-- The cursor must be a real block. Script membership is checked in the write path rather than
-- here -- a check constraint cannot reach another table -- and is covered by its own test, so a
-- block belonging to a different script cannot be set as this run's cursor.
alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_current_block_fk;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_current_block_fk
  foreign key (organization_id, current_block_id)
  references pilot.session_script_blocks(organization_id, block_id);

-- One live run per coach. See header: this is what makes resume unambiguous.
create unique index if not exists pilot_ssrun_one_live_per_coach
  on pilot.session_script_runs(organization_id, delivered_by_account_id)
  where run_state = 'in_progress';

-- Resume looks up a coach's live run; this index serves exactly that query.
create index if not exists pilot_ssrun_live
  on pilot.session_script_runs(organization_id, run_state)
  where run_state = 'in_progress';
