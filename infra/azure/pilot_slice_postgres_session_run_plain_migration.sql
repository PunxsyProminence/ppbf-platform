-- Session runs: a plain session, with no script.
--
-- WHY. Jason, 2026-10-12 (question card, issue #1523): "A: Yes, allow a plain session
-- (Recommended)". "Start a session" opens a session straight away; a script is optional. Today a
-- coach's live session is a pilot.session_script_runs row, and script_id / script_version are NOT
-- NULL, so a gym with no session scripts (they arrive only through content import) cannot start a
-- session at all (audit F-052): no live run, so nothing to put on the gym TV.
--
-- WHAT CHANGES. On pilot.session_script_runs:
--   script_id, script_version -- nullable. A run with both NULL is a plain session. The script
--                                foreign key (pilot_ssrun_script_fk) is unchanged; it skips a NULL
--                                script_id by definition, so a scripted run is held to it as before.
--   pilot_ssrun_script_pair   -- both set or both NULL: a version without a script, or a script
--                                without its pinned version, is not a run anyone can read.
--   pilot_ssrun_plain_has_state -- a plain run is a tracked run (run_state set). A pre-tracking
--                                legacy row always had a script, and a NULL run_state plain row
--                                would be exempt from every state check.
--   pilot_ssrun_plain_no_cursor -- a plain run has no block, so it never has a block cursor.
--   pilot_ssrun_cursor_matches_state -- redefined: a live SCRIPTED run still needs its cursor; a
--                                live PLAIN run has none. Settled runs have no cursor, as before.
-- Nothing else moves: one live run per coach, the pause and time checks, show_on_wall, and every
-- reader of scripted runs are untouched.
--
-- THE SAME CHECK IN TWO FILES. pilot_slice_postgres_session_run_state_migration.sql defines
-- pilot_ssrun_cursor_matches_state and is re-run by the `all` chain before this file. It now
-- carries the same expression, so re-running it on a database that already holds a live plain run
-- does not fail; this file restates it so it is right whichever ran last.
--
-- Requires pilot.session_script_runs with run_state (pilot_slice_postgres_session_scripts_migration.sql,
-- then pilot_slice_postgres_session_run_state_migration.sql); the `all` chain runs both first.
--
-- Idempotent: drop not null is a no-op on a nullable column; each check is dropped and re-added.
-- No `begin;`/`commit;` here: the runner (apps/web/scripts/pilot-apply-session-run-plain-migration.mjs)
-- opens the transaction and asserts the result before committing.

alter table pilot.session_script_runs alter column script_id drop not null;
alter table pilot.session_script_runs alter column script_version drop not null;

alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_script_pair;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_script_pair
  check ((script_id is null) = (script_version is null));

alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_plain_has_state;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_plain_has_state
  check (script_id is not null or run_state is not null);

alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_plain_no_cursor;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_plain_no_cursor
  check (script_id is not null or current_block_id is null);

alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_cursor_matches_state;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_cursor_matches_state check (
    run_state is null
    or (run_state = 'in_progress' and (current_block_id is not null or script_id is null))
    or (run_state in ('completed', 'abandoned') and current_block_id is null)
  );

comment on column pilot.session_script_runs.script_id is
  'The script this run delivers, or NULL for a plain session (issue #1523). Set together with script_version (pilot_ssrun_script_pair).';
comment on column pilot.session_script_runs.script_version is
  'The script version pinned at start, or NULL for a plain session. Set together with script_id (pilot_ssrun_script_pair).';
