-- Session close: WHEN a training session ended and WHAT closed it, recorded
-- on the session itself.
--
-- WHY. pilot.sessions marks a finished session with completed_flag, and the
-- only stamp beside it is updated_at. The athlete's rail reads updated_at as
-- the check-out time (AthleteWorkspace.tsx, "on a completed session that is
-- the check-out"), but updated_at is the LAST write, and /api/pilot/sessions
-- and /sessions/update both admit coaches and organization admins, so a staff
-- edit after the fact moves the "check-out time" with it. Nothing records who
-- or what closed a session, and nothing closes a session nobody checked out
-- of: the screen simply stops showing yesterday's open row.
--
-- Owner ruling OD-2026-10-06-024 Q4 (docs/current/OWNER_DECISIONS.md), in
-- Jason's words: "1 bt check in give 20 min before auto close if nothing else
-- is used in the ap for the athlet auto close and keep record of the 20 min
-- inactivity". This migration is the storage half of that: it holds a manual
-- check-out's time and, for a session the app closes, the inactivity record
-- the ruling asks for. The auto-close mechanism itself is NOT here: what
-- counts as "nothing else is used in the app" is not yet ruled, and the
-- columns are shaped so either answer fits without a second migration.
--
-- WHAT THIS DOES. Four nullable columns and two checks. Additive only.
--
--   checked_out_at      when the session ended. A manual check-out stamps the
--                       SERVER clock at the write that flips completed_flag
--                       false -> true (never a client-sent value). An
--                       auto-close stamps last_activity_at + the window.
--   close_method        what closed it: 'athlete_check_out', 'staff_check_out'
--                       (a coach or admin completing it through the same
--                       routes, which they may today), or 'auto_inactivity'.
--                       NULL = not recorded, never proof of a method -- the
--                       same reading as session_tokens.sign_in_method.
--   last_activity_at    auto-close only: the newest activity signal found for
--                       the athlete when the session was closed.
--   inactivity_minutes  auto-close only: the window the rule used (20 today).
--                       Stored on the row so the record keeps "the 20 min
--                       inactivity" even if the window is changed later.
--
--   * NULL is the honest value for every existing row. Nothing is backfilled
--     from updated_at: that stamp is a proxy for the check-out time, not a
--     record of it, and writing it into checked_out_at would turn the proxy
--     into a claim.
--   * Session LENGTH is not stored. checked_out_at - created_at is computed
--     where it is shown, the same ruling as session load (see
--     pilot_slice_postgres_session_duration_migration.sql). For an
--     auto-closed row both readings stay available from the stored columns:
--     last_activity_at - created_at (idle excluded) and checked_out_at -
--     created_at (idle included). Which one a screen shows is the owner's
--     open question; it needs no schema change either way.
--   * duration_minutes is untouched. It stays the athlete's own answer to
--     "how many minutes did you train?", with its own writer rule.
--
-- THE CHECKS, in plain words: a row may not name HOW it closed without
-- saying WHEN; and a row closed for inactivity must carry the activity stamp
-- and the window that justify it. Open sessions and rows written before this
-- migration satisfy both with all four NULL.
--
-- Idempotent: add column if not exists, catalog-guarded constraints, no
-- drops, no data changes. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-session-close-migration.mjs).

alter table pilot.sessions
  add column if not exists checked_out_at timestamptz null;

alter table pilot.sessions
  add column if not exists close_method text null;

alter table pilot.sessions
  add column if not exists last_activity_at timestamptz null;

alter table pilot.sessions
  add column if not exists inactivity_minutes integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_close_method_check'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions add constraint pilot_sessions_close_method_check
      check (close_method is null
             or close_method in ('athlete_check_out', 'staff_check_out', 'auto_inactivity'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_close_record_check'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions add constraint pilot_sessions_close_record_check
      check (
        (close_method is null or checked_out_at is not null)
        and (inactivity_minutes is null or inactivity_minutes between 1 and 1440)
        and (close_method is distinct from 'auto_inactivity'
             or (last_activity_at is not null and inactivity_minutes is not null))
      );
  end if;
end
$$;

comment on column pilot.sessions.checked_out_at is
  'When the session ended. Manual check-out: server clock at the completed_flag false->true write. Auto-close: last_activity_at + inactivity_minutes. NULL on open sessions and on every row written before the session-close migration (updated_at is a proxy, not a record).';

comment on column pilot.sessions.close_method is
  'What closed the session: athlete_check_out | staff_check_out | auto_inactivity. NULL = not recorded, never proof of a method.';

comment on column pilot.sessions.last_activity_at is
  'Auto-close only: the newest app activity signal found for the athlete when the session was closed (OD-2026-10-06-024 Q4). NULL on manual closes.';

comment on column pilot.sessions.inactivity_minutes is
  'Auto-close only: the inactivity window the rule used when it closed this session (20 per OD-2026-10-06-024 Q4). Kept on the row so the record survives a later change of the window.';
