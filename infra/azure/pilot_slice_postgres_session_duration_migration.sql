-- Session duration: how many minutes the athlete says they trained, recorded
-- on the session itself at check-out.
--
-- WHY. pilot.sessions holds session RPE (rpe + rpe_method) but no duration,
-- so session load -- session RPE x minutes (Foster et al. 2001) -- could not be
-- computed for any session the athlete check-out writes. pilot.activity_log
-- has duration_minutes, but nothing on the athlete check-out path writes an
-- activity_log row, so the two numbers never meet on one record.
--
-- WHAT THIS DOES. One nullable column and one range check. Additive only.
--
--   * NULL is the honest value for every existing row: nobody was asked, so
--     nothing is backfilled -- not a default, not a guess from created_at to
--     updated_at (check-out time is when the button was pressed, not when
--     training ended).
--   * NULL is also a real answer going forward: the box at check-out is
--     optional, exactly like the effort question beside it.
--   * 1..300 minutes. 0 is not a session; past five hours is a typing slip on
--     a gym-floor tablet, not a training session. The application validates
--     the same bounds so a caller gets a 400 naming the field instead of a
--     constraint violation.
--
-- NOT DONE HERE, DELIBERATELY:
--   * No derived load column. Same ruling as
--     pilot_slice_postgres_sparring_exposure_and_load_migration.sql: sRPE x
--     duration has not been validated in boxing, so it is computed in the
--     query that needs it and labelled unvalidated where it is shown.
--   * No flag, score or threshold on load.
--   * No duration_method column. The only writer is the athlete's own answer
--     at check-out; a second writer (coach-entered, door terminal) would need
--     a method column in its own migration, as rpe_method did.
--
-- Idempotent: add column if not exists, catalog-guarded constraint, no drops,
-- no data changes. No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-session-duration-migration.mjs).

alter table pilot.sessions
  add column if not exists duration_minutes integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_duration_minutes_range'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions add constraint pilot_sessions_duration_minutes_range
      check (duration_minutes is null or duration_minutes between 1 and 300);
  end if;
end
$$;
