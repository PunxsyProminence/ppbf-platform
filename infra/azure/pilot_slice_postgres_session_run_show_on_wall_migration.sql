-- Session runs: the coach's "Show on TV" switch.
--
-- WHY. The gym TV (/wall) will follow a live session block by block (gym TV lane, slice S1 of the
-- plan in Documents/PPBF-overwatch/lane-inbox/GYM-TV-WORKOUT-plan-2026-10-06.md). Jason chose a
-- per-session coach switch over "every live session shows" (relayed by overwatch 2026-10-06:
-- "Coach switch"), so a coach can run a private lesson on a phone without it going up on the
-- wall. This column is that switch. Nothing reads it for the TV yet; the wall payload is the next
-- slice and reads only runs where it is true.
--
-- WHAT CHANGES. One column on pilot.session_script_runs:
--   show_on_wall -- true while the coach has this live run up on the gym TV. Defaults to false,
--                   so a run started by any client, old or new, is off the TV until a coach
--                   turns it on, and every existing row (live or settled) reads false.
-- And one check: only a live run can be on the TV. A settled or legacy row showing on the wall
-- would put last night's session up as if it were happening now, so finishing a run has to turn
-- the switch off (sessionScriptRuns.ts finishSessionScriptRun does, in the same update).
--
-- Requires pilot.session_script_runs with run_state
-- (pilot_slice_postgres_session_scripts_migration.sql, then
-- pilot_slice_postgres_session_run_state_migration.sql); the `all` chain runs both first.
--
-- Idempotent: add column if not exists; the check is dropped and re-added on every run. No
-- `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-session-run-show-on-wall-migration.mjs) opens the transaction.

alter table pilot.session_script_runs
  add column if not exists show_on_wall boolean not null default false;

alter table pilot.session_script_runs
  drop constraint if exists pilot_ssrun_wall_only_live;
alter table pilot.session_script_runs
  add constraint pilot_ssrun_wall_only_live
  check (not show_on_wall or run_state = 'in_progress');

comment on column pilot.session_script_runs.show_on_wall is
  'True while the delivering coach has this live run on the gym TV (/wall). Only a live run can be shown (pilot_ssrun_wall_only_live); finishing a run turns it off.';
