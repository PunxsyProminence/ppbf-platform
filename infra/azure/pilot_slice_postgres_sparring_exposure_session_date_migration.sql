-- Sparring exposure without an activity_log row -- coach floor entry.
--
-- WHY. pilot.sparring_exposure.activity_id was NOT NULL with a foreign key to
-- pilot.activity_log, and pilot.activity_log.person_account_id is NOT NULL
-- with a foreign key to pilot.accounts. Creating an athlete creates no
-- account (src/server/pilot/entities.ts inserts into pilot.athletes only), so
-- under the old shape a coach could not record sparring at all for an athlete
-- without a sign-in -- most of the gym's minors. Writing an activity_log row
-- to make room for it would also have written attendance and tenure as a side
-- effect (attendancePrecedence.ts ranks activity_log first), which recording a
-- sparring round must not do.
--
-- WHAT CHANGES (overwatch GO A, 2026-10-04):
--   * activity_id becomes nullable. The foreign key to pilot.activity_log is
--     KEPT and still holds whenever activity_id is set (MATCH SIMPLE: a null
--     member skips the check, a non-null one is checked as before).
--   * session_date (date) is added: the gym day the sparring happened on. It
--     has NO default on purpose. current_date is the server's UTC day, which
--     names tomorrow every evening while the gym is still training; the
--     application supplies the gym day explicitly.
--   * An unlinked row (activity_id null) must carry session_date
--     (pilot_sparring_exposure_session_date_or_activity). A linked row may
--     leave it null, as every row written before this migration does.
--   * Unlinked rows are unique per (organization, athlete, session_date,
--     segment_number) via a PARTIAL unique index. pilot_sparring_exposure_segment_uq
--     is untouched and still keys linked rows.
--
-- NO DATA IS REWRITTEN. No existing row is updated: before this migration
-- activity_id was NOT NULL, so every existing row already satisfies the new
-- check, and none falls under the partial index's predicate. If an earlier run
-- of this file was partly undone by hand and unlinked duplicates now exist,
-- the guard below refuses with a named error rather than altering any row.
--
-- STILL REFUSED, MATCHING THE ORIGINAL MIGRATION'S HEADER: no damage score, no
-- cumulative risk index, no recommended limit, no clearance.
--
-- DEPENDS ON sparring-exposure (pilot_slice_postgres_sparring_exposure_and_load_migration.sql).
-- No begin;/commit; here, matching this repo's runner-opens-the-transaction
-- convention; the runner is
-- apps/web/scripts/pilot-apply-sparring-exposure-session-date-migration.mjs.

do $$
begin
  if to_regclass('pilot.sparring_exposure') is null then
    raise exception 'SPARRING_EXPOSURE_SESSION_DATE_REQUIRES_SPARRING_EXPOSURE: apply sparring-exposure first';
  end if;
end
$$;

alter table pilot.sparring_exposure alter column activity_id drop not null;

alter table pilot.sparring_exposure add column if not exists session_date date null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pilot_sparring_exposure_session_date_or_activity'
                 and conrelid = 'pilot.sparring_exposure'::regclass) then
    alter table pilot.sparring_exposure add constraint pilot_sparring_exposure_session_date_or_activity
      check (activity_id is not null or session_date is not null);
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pilot.sparring_exposure
    where activity_id is null
    group by organization_id, athlete_id, session_date, segment_number
    having count(*) > 1
  ) then
    raise exception 'SPARRING_EXPOSURE_SESSION_SEGMENT_DUPLICATES_EXIST: unlinked rows repeat (organization, athlete, session_date, segment_number); resolve them by hand -- this migration does not alter data';
  end if;
end
$$;

create unique index if not exists pilot_sparring_exposure_session_segment_uq
  on pilot.sparring_exposure(organization_id, athlete_id, session_date, segment_number)
  where activity_id is null;
