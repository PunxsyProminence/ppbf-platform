-- Workout templates and their items: a `details` JSON object for every Backbone field with no
-- column of its own (lane YR, the youth + recreational stage content; OD-2026-11-15-006 ruling 2).
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
-- WHAT CHANGES. One column on each of pilot.workout_templates and pilot.workout_template_items:
--   details jsonb not null default '{}', checked to be a JSON object.
-- Every existing row reads '{}'. No existing column, check or index changes, and no row's value
-- changes. The content-import engine (datasets/templateScriptVersions.ts) already reads and writes
-- jsonb columns, so a template whose package leaves details blank hashes as it did before.
--
-- Requires pilot.workout_templates and pilot.workout_template_items
-- (pilot_slice_postgres_workout_templates_v2_migration.sql); the `all` chain runs it first.
--
-- Idempotent: add column if not exists; each check is added only when its name is missing. No
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

comment on column pilot.workout_templates.details is
  'Every Backbone field of the template with no column of its own, whole, by its Backbone name (lane YR). A JSON object; {} when there is none.';
comment on column pilot.workout_template_items.details is
  'Every Backbone field of the item with no column of its own, whole, by its Backbone name (lane YR). A JSON object; {} when there is none.';
