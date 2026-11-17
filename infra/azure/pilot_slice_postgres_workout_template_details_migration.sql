-- Workout templates and their items: a `details` JSON object for every Backbone field with no
-- column of its own, a session length of 1 to 180 minutes, and an item that names a drill, free
-- text or details (lane YR, the youth + recreational stage content; OD-2026-11-15-006 ruling 2).
--
-- WHY. The 33 youth and recreational session templates in the frozen Backbone carry fields the
-- template tables have no column for: on the template contact_structure, owner_passages,
-- source_sections, field_provenance, block_notes, conditioning_categories, use_rule, differences,
-- extension_rule, placement_rule, placement_condition, print_ready_layout and structure; on an
-- item phase, time, block_time, block_title, plan_items, parts, changed_by, timing,
-- within_item_id, owner_source, rung, time_lines and round_focus_rule. Nothing in the Backbone is
-- withheld (RULES s0), so they load whole, by their Backbone names, into `details`, as a training
-- track's do (pilot_slice_postgres_training_tracks_migration.sql). Overwatch ruled the column
-- (lane YR step 1, Q3 A).
--
-- WHAT CHANGES.
--   1. One column on each of pilot.workout_templates and pilot.workout_template_items:
--      details jsonb not null default '{}', checked to be a JSON object. Every existing row reads
--      '{}'. The content-import engine (datasets/templateScriptVersions.ts) already reads and writes
--      jsonb columns, so a template whose package leaves details blank hashes as it did before.
--   2. workout_templates_duration_minutes_check: 1 to 180 minutes, was 15 to 180. The Backbone's
--      "permanent circuit" is a written ~10-minute protocol (Overwatch, applied under
--      OD-2026-11-17-001: drafting over a written value would be inventing). Same name, wider.
--   3. pilot_wti_one_source: an item names at least one of drill_id, free_text_drill or a
--      non-empty details, was exactly one of drill_id and free_text_drill. 11 frozen items carry
--      their content only in details (a scripted youth class's parts, a cool-down line) and 1 names
--      both a drill and its dosage as text (Overwatch, lane YR one_source A). Same name, wider.
-- Both checks are wider: every row that passed the old check passes the new one, and no row's
-- value changes. pilot_wti_no_contact_volume is unchanged (OD-2026-11-17-002).
--
-- Requires pilot.workout_templates and pilot.workout_template_items
-- (pilot_slice_postgres_workout_templates_v2_migration.sql); the `all` chain runs it first.
--
-- Idempotent: add column if not exists; each check is added only when its name is missing; a
-- check still holding its OLD definition is dropped first and re-added under the same name. No
-- `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-workout-template-details-migration.mjs) opens the transaction.

do $$
begin
  if to_regclass('pilot.workout_templates') is null or to_regclass('pilot.workout_template_items') is null then
    raise exception 'WORKOUT_TEMPLATE_DETAILS_NOT_READY: pilot.workout_templates or pilot.workout_template_items does not exist -- apply the workout-templates-v2 migration first';
  end if;
end
$$;

alter table pilot.workout_templates
  add column if not exists details jsonb not null default '{}'::jsonb;

alter table pilot.workout_template_items
  add column if not exists details jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'pilot_workout_templates_details_check'
                   and conrelid = 'pilot.workout_templates'::regclass) then
    alter table pilot.workout_templates add constraint pilot_workout_templates_details_check
      check (jsonb_typeof(details) = 'object');
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'pilot_wti_details_check'
                   and conrelid = 'pilot.workout_template_items'::regclass) then
    alter table pilot.workout_template_items add constraint pilot_wti_details_check
      check (jsonb_typeof(details) = 'object');
  end if;
end
$$;

-- 2 and 3: replace a check only while it still holds its old definition, so a rerun is a no-op.
do $$
begin
  if exists (select 1 from pg_constraint
             where conname = 'workout_templates_duration_minutes_check'
               and conrelid = 'pilot.workout_templates'::regclass
               and pg_get_constraintdef(oid) like '%(duration_minutes >= 15)%') then
    alter table pilot.workout_templates drop constraint workout_templates_duration_minutes_check;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'workout_templates_duration_minutes_check'
                   and conrelid = 'pilot.workout_templates'::regclass) then
    alter table pilot.workout_templates add constraint workout_templates_duration_minutes_check
      check (duration_minutes between 1 and 180);
  end if;

  if exists (select 1 from pg_constraint
             where conname = 'pilot_wti_one_source'
               and conrelid = 'pilot.workout_template_items'::regclass
               and pg_get_constraintdef(oid) not like '%details%') then
    alter table pilot.workout_template_items drop constraint pilot_wti_one_source;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'pilot_wti_one_source'
                   and conrelid = 'pilot.workout_template_items'::regclass) then
    alter table pilot.workout_template_items add constraint pilot_wti_one_source
      check (drill_id is not null or free_text_drill is not null or details <> '{}'::jsonb);
  end if;
end
$$;

comment on column pilot.workout_templates.details is
  'Every Backbone field of the template with no column of its own, whole, by its Backbone name (lane YR). A JSON object; {} when there is none.';
comment on column pilot.workout_template_items.details is
  'Every Backbone field of the item with no column of its own, whole, by its Backbone name (lane YR). A JSON object; {} when there is none.';
