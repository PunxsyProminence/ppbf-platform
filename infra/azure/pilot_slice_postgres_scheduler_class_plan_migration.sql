-- A scheduled class names the session plan it will run (lane W4-5, step SP-3
-- of the W4-5 plan on #2189: "Migration: a plan link on a scheduled class; the
-- scheduler accepts it").
--
-- WHY. A row of pilot.scheduler_classes names no session plan, so a class
-- scheduled from a plan cannot say which plan it is for. This file adds that
-- link and nothing else.
--
-- WHAT. It is ADDITIVE: one nullable column, one foreign key and one index on
-- pilot.scheduler_classes. It changes no existing row; every class already
-- scheduled reads as a class with no plan. The scheduler's create_class writes
-- the column (apps/web/src/server/pilot/schedulerDb.ts createSchedulerClasses,
-- in the same pull request as this file); reading it back and starting the
-- class's plan is SP-4's.
--
-- 1. pilot.scheduler_classes.script_id -- the session plan this class runs,
--    or null (a class with no plan). No default: a default would stamp every
--    class with a plan nobody chose.
--
-- 2. A foreign key to pilot.session_scripts in the SAME gym. The plan's key is
--    (organization_id, script_id) (pilot_session_scripts_pkey, in
--    pilot_slice_postgres_session_scripts_migration.sql), so the class's own
--    organization_id is part of the reference and a class cannot name another
--    gym's plan, whatever id the app sends.
--
--    If a plan row is ever deleted the class keeps its row and loses only the
--    link: `on delete set null (script_id)`, the column-list form, so
--    organization_id is left alone (the whole-key form nulls organization_id
--    too and fails at delete time, organization_id being `not null` in
--    pilot_slice_postgres_scheduler_tables_migration.sql; see
--    pilot_slice_postgres_session_run_class_migration.sql, which uses this
--    form for session_script_runs.class_id). No code deletes a plan today:
--    sessionScriptAuthoring.ts's header says "nothing here deletes a row".
--    An organization delete cascades to both tables, as it already does (each
--    table's organization_id is `on delete cascade` in its own migration).
--
-- 3. A plain partial index on (organization_id, script_id) where script_id is
--    not null: what the foreign key's set-null looks classes up by when a plan
--    row is deleted, and "the classes of this plan".
--
-- THE STORED ID MAY NAME AN OLDER VERSION OF THE PLAN. A coach's edit of a plan
-- that has been run is written as a new version in the same lineage, and the
-- browse list and the start check follow the highest version
-- (sessionScriptAuthoring.ts header; sessionScriptRuns.ts startSessionScriptRun
-- refuses a superseded version with SESSION_SCRIPT_SUPERSEDED). The class keeps
-- the id it was scheduled with; the start follows that plan's lineage to its
-- newest version (the W4-5 plan, section 2 finding 9). WHICH plan a caller may
-- link (one of its own gym's) is the module's rule, not this file's.
--
-- DEPENDS ON pilot.scheduler_classes (scheduler-tables) and
-- pilot.session_scripts (session-scripts).
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-scheduler-class-plan-migration.mjs) opens the
-- transaction itself and sets lock_timeout. Idempotent: every statement guards
-- itself, because the `all` chain re-runs every migration on every dispatch.
-- The guards read the catalog BEFORE altering, so a re-run takes none of the
-- column, key or index locks (`add column if not exists` and `create index if
-- not exists` would each lock the table first and check after), and does not
-- wait on a class write in progress (schedulerClassPlanMigration.pg.test.ts,
-- "a re-run does not wait on a class write in progress").

do $$
begin
  -- Fail loudly rather than installing half of it.
  if to_regclass('pilot.scheduler_classes') is null then
    raise exception 'pilot.scheduler_classes is missing: apply the scheduler-tables migration first';
  end if;
  if to_regclass('pilot.session_scripts') is null then
    raise exception 'pilot.session_scripts is missing: apply the session-scripts migration first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The plan a class runs.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('pilot.scheduler_classes') and attname = 'script_id' and not attisdropped
  ) then
    alter table pilot.scheduler_classes add column script_id text null;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_scheduler_classes_script_fk'
       and conrelid = to_regclass('pilot.scheduler_classes')
  ) then
    alter table pilot.scheduler_classes
      add constraint pilot_scheduler_classes_script_fk
      foreign key (organization_id, script_id)
      references pilot.session_scripts(organization_id, script_id)
      on delete set null (script_id);
  end if;

  -- "The classes of this plan", and the foreign key's set-null on a plan
  -- delete, which looks classes up by (organization_id, script_id).
  if to_regclass('pilot.pilot_scheduler_classes_script') is null then
    create index pilot_scheduler_classes_script
      on pilot.scheduler_classes(organization_id, script_id)
      where script_id is not null;
  end if;
end $$;

comment on column pilot.scheduler_classes.script_id is
  'The session plan this class runs (lane W4-5), or null for a class with no plan. The start follows the newest version of that plan''s lineage (sessionScriptRuns.ts startSessionScriptRun refuses a superseded version with SESSION_SCRIPT_SUPERSEDED; sessionScriptAuthoring.ts''s header: the browse list and the start check follow the highest version), so the stored id may name an older version of the plan. Which plan a caller may link is the module''s rule (the gym''s own), not this file''s.';
