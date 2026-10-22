-- A live session tied to the scheduled class it is running, so a coach enters
-- attendance once (D4, OD-2026-10-21-002, Jason: "A: Tie them (Rec.)").
--
-- WHY. A coach running a class marked who was there twice: once in the class
-- register (pilot.scheduler_attendance) and again on the live session's "who
-- is here" list (pilot.session_run_athletes). Nothing joined the two: the run
-- row (pilot.session_script_runs) names no class.
--
-- This file is the schema for the fix and nothing else. It is ADDITIVE: it
-- adds nullable columns, constraints and indexes, and changes no existing row.
-- No code on main reads or writes the new columns when this lands; the server
-- and the screens follow in their own pull requests, after this is applied.
--
-- 1. pilot.session_script_runs.class_id -- the scheduled class this session is
--    running, or null (an open-gym session, tied to nothing). A foreign key to
--    pilot.scheduler_classes in the SAME gym. If a class row is ever deleted
--    the session keeps its history and loses only the tie: `on delete set null
--    (class_id)`, the column-list form, so organization_id is left alone (the
--    whole-key form nulls organization_id too and fails at delete time; see the
--    coach-development migration). pilot_slice_postgres_gym_tvs_migration.sql
--    already uses this form for gym_tvs.current_run_id. No code deletes a class
--    today; a class is cancelled by status.
--
--    ONE LIVE SESSION PER CLASS, held by the database: a partial unique index
--    over live runs (run_state = 'in_progress'), the same shape as the existing
--    one-live-run-per-coach index. Two coaches cannot both be running the same
--    class, so the register has one live writer per class. Finished sessions
--    of a class are not limited.
--
--    WHICH class a coach may tie (today's, not cancelled, one they teach,
--    schedule or cover; an organization admin any) is the module's rule, not
--    this file's: a check constraint cannot read the class row or the clock.
--
-- 2. pilot.session_run_athletes.register_class_id / register_written_at -- set
--    only when a "here" tap on a tied session CREATED the athlete's class
--    register mark. They record which class's register mark the tap made and
--    that mark's updated_at as written, so the app can take the mark back on
--    undo only if nobody has changed it since (OD-2026-10-21-004 ruling 2,
--    Jason: "A: Undo if untouched (Rec.)"). A tap that found the athlete
--    already Present, or that turned an Absent or Excused mark into Present
--    (ruling 1, "A: Here wins (Rec.)"), did not create the register mark and
--    sets neither.
--
--    THE POINTER CAN ONLY NAME THIS ATHLETE'S OWN MARK. The foreign key is
--    (organization_id, register_class_id, athlete_id) -> the register's own
--    one-mark-per-athlete-per-class key (organization_id, class_id,
--    athlete_id), using the session mark's athlete_id. So it names a real
--    register mark of the same gym, of the same athlete, and of a named class:
--    an undo built on it cannot reach another child's mark however the app
--    computes it.
--
--    When the register mark goes (the app's undo, or a delete cascading from
--    its class or athlete) only register_class_id is nulled (`on delete set
--    null (register_class_id)`); the session mark itself is never deleted by
--    it. Hence the check is one-directional: a pointer always carries its time;
--    a time whose mark has gone other than by the app's undo stays as the
--    record that the tap wrote one.
--
--    ONE OWNER PER REGISTER MARK: a partial unique index, so no two session
--    marks (two sessions of the same class) claim the same register mark and an
--    undo of one cannot remove a mark another relies on. It is also the index
--    the foreign key's set-null looks rows up by when a register mark is
--    deleted.
--
-- NOTHING HERE CHANGES WHAT COUNTS AS ATTENDANCE. pilot.scheduler_attendance,
-- its methods and pilot.attendance_reconciled are not altered: a tied tap will
-- write an ordinary register mark through the scheduler's own code, and the
-- per-day view keeps reading the register as it does today. An untied (open
-- gym) session's marks stay session detail only (OD-2026-10-13-016).
--
-- DEPENDS ON pilot.session_script_runs (session-scripts, session-run-state,
-- session-run-plain), pilot.session_run_athletes (session-run-athletes),
-- pilot.scheduler_classes and pilot.scheduler_attendance (scheduler-tables).
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-session-run-class-migration.mjs) opens the
-- transaction itself and sets lock_timeout. Idempotent: every statement guards
-- itself, because the `all` chain re-runs every migration on every dispatch.
-- The guards read the catalog BEFORE altering, so a re-run takes no lock on the
-- live session tables (`add column if not exists` and `create index if not
-- exists` would each lock the table first and check after).

do $$
begin
  -- Fail loudly rather than installing half of it.
  if to_regclass('pilot.session_script_runs') is null then
    raise exception 'pilot.session_script_runs is missing: apply the session-scripts migration first';
  end if;
  if to_regclass('pilot.session_run_athletes') is null then
    raise exception 'pilot.session_run_athletes is missing: apply the session-run-athletes migration first';
  end if;
  if to_regclass('pilot.scheduler_classes') is null or to_regclass('pilot.scheduler_attendance') is null then
    raise exception 'the scheduler tables are missing: apply the scheduler-tables migration first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The class a session is running.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('pilot.session_script_runs') and attname = 'class_id' and not attisdropped
  ) then
    alter table pilot.session_script_runs add column class_id text null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_ssrun_class_fk'
       and conrelid = to_regclass('pilot.session_script_runs')
  ) then
    alter table pilot.session_script_runs
      add constraint pilot_ssrun_class_fk
      foreign key (organization_id, class_id)
      references pilot.scheduler_classes(organization_id, class_id)
      on delete set null (class_id);
  end if;

  -- One live session per class. See header.
  if to_regclass('pilot.pilot_ssrun_one_live_per_class') is null then
    create unique index pilot_ssrun_one_live_per_class
      on pilot.session_script_runs(organization_id, class_id)
      where run_state = 'in_progress' and class_id is not null;
  end if;

  -- "The sessions of this class", and the foreign key's set-null on a class
  -- delete, which looks runs up by (organization_id, class_id) live or not.
  if to_regclass('pilot.pilot_ssrun_class') is null then
    create index pilot_ssrun_class
      on pilot.session_script_runs(organization_id, class_id)
      where class_id is not null;
  end if;
end $$;

comment on column pilot.session_script_runs.class_id is
  'The scheduled class this session is running (D4, OD-2026-10-21-002), or null for a session tied to no class (open gym, whose marks stay session detail only: OD-2026-10-13-016). At most one live session per class (pilot_ssrun_one_live_per_class). Which class a coach may tie is the module''s rule.';

-- ---------------------------------------------------------------------------
-- 2. The register mark a "here" tap created.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('pilot.session_run_athletes') and attname = 'register_class_id' and not attisdropped
  ) then
    alter table pilot.session_run_athletes add column register_class_id text null;
  end if;

  if not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('pilot.session_run_athletes') and attname = 'register_written_at' and not attisdropped
  ) then
    alter table pilot.session_run_athletes add column register_written_at timestamptz null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_session_run_athletes_register_fk'
       and conrelid = to_regclass('pilot.session_run_athletes')
  ) then
    alter table pilot.session_run_athletes
      add constraint pilot_session_run_athletes_register_fk
      foreign key (organization_id, register_class_id, athlete_id)
      references pilot.scheduler_attendance(organization_id, class_id, athlete_id)
      on delete set null (register_class_id);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_session_run_athletes_register_written'
       and conrelid = to_regclass('pilot.session_run_athletes')
  ) then
    alter table pilot.session_run_athletes
      add constraint pilot_session_run_athletes_register_written
      check (register_class_id is null or register_written_at is not null);
  end if;

  -- One owner per register mark. See header.
  if to_regclass('pilot.pilot_session_run_athletes_register_owner') is null then
    create unique index pilot_session_run_athletes_register_owner
      on pilot.session_run_athletes(organization_id, register_class_id, athlete_id)
      where register_class_id is not null;
  end if;
end $$;

comment on column pilot.session_run_athletes.register_class_id is
  'The class whose register mark (pilot.scheduler_attendance, for this row''s athlete) this "here" tap CREATED on a session tied to that class (D4), so undo can take it back if unchanged (OD-2026-10-21-004 ruling 2). Null when the tap created none: an untied session, the athlete already Present, or an Absent/Excused mark turned Present (ruling 1). Nulled, never cascaded, if that register mark is deleted.';

comment on column pilot.session_run_athletes.register_written_at is
  'The register mark''s updated_at as this tap wrote it; undo removes the mark only while its updated_at still equals this. Set with register_class_id. If the register mark is deleted other than by that undo, only register_class_id is nulled and this stays, as the record that the tap wrote one.';
