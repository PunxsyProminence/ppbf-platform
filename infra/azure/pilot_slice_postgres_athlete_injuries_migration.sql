-- Athlete injury record (pilot.athlete_injuries), map item 11.
--
-- ONE ROW = ONE INJURY to one athlete, recorded by a coach or organization
-- admin. It is NOT a diagnosis: the row records what a person reported
-- (the athlete, a parent or guardian, a coach who saw it) or what a clinician
-- stated, and `reported_by` says which. Nothing here computes, infers or clears
-- anything, and nothing here blocks training: a training hold
-- (pilot.training_holds) remains the only thing that stops a child training.
--
-- REUSE, NOT DUPLICATION. The records the platform already keeps are LINKED,
-- never copied:
--   linked_rtt_plan_id         -> pilot.return_to_training_plans (a confirmed
--                                 concussion's human-set rest period and
--                                 earliest return date live there)
--   linked_hold_id             -> pilot.training_holds
--   linked_clearance_status_id -> pilot.shadow_medical_administrative_status
--   linked_pain_report_id      -> pilot.shadow_near_misses (the athlete's own
--                                 pain report)
-- When a return-to-training plan is linked, its earliest_return_date IS the
-- expected return; this row may not carry a second one
-- (pilot_athlete_injuries_one_return_source). That a linked record names the
-- same athlete in the same organization is checked by the module
-- (athleteInjuries.ts) in the writing transaction; the foreign keys below
-- guarantee the linked record exists.
--
-- DELETION. Rows are tied to the athlete by the composite foreign key with
-- ON DELETE CASCADE, so the retention purge (pilot-cleanup-deleted-data.mjs,
-- `delete from pilot.athletes`) removes them with the athlete. Before the
-- purge, the athlete row's own deleted_at is the mark: every read in
-- athleteInjuries.ts filters through athleteNotDeletedSql. No deleted_at column
-- of its own, by the same reasoning deletedAthletes.ts records.
--
-- There is no app delete. A row entered by mistake is marked
-- entered_in_error = true, which takes it off every list and keeps who did it.
--
-- Depends on: pilot_slice_postgres.sql (athletes, training_holds),
-- pilot_slice_postgres_shadow_decision_loop_migration.sql (medical status,
-- near misses), pilot_slice_postgres_safety_flags_migration.sql
-- (return-to-training plans). All are earlier in apply-migrations.yml's list.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-injuries-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists throughout.

create table if not exists pilot.athlete_injuries (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  injury_id         uuid not null,
  athlete_id        text not null,
  injury_date       date not null,
  body_area         text not null
    constraint pilot_athlete_injuries_body_area_check check (body_area in (
      'head', 'face', 'neck', 'shoulder', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand',
      'chest', 'ribs', 'abdomen', 'back', 'hip', 'groin', 'thigh', 'knee', 'lower_leg',
      'ankle', 'foot', 'other')),
  injury_type       text not null
    constraint pilot_athlete_injuries_type_check check (injury_type in (
      'sprain_strain', 'cut', 'fracture', 'head_injury', 'other')),
  context           text not null
    constraint pilot_athlete_injuries_context_check check (context in ('training', 'competition')),
  reported_by       text not null
    constraint pilot_athlete_injuries_reported_by_check check (reported_by in (
      'athlete', 'parent_guardian', 'coach_observed', 'clinician')),
  -- Staff-only: what was reported or stated, in the reporter's words. Never
  -- shown to the athlete or guardian.
  staff_note        text not null default ''
    constraint pilot_athlete_injuries_note_check check (length(staff_note) <= 2000),
  expected_return_date date null,
  returned_on       date null,
  linked_rtt_plan_id text null,
  linked_hold_id    text null,
  linked_clearance_status_id uuid null
    references pilot.shadow_medical_administrative_status(status_id) on delete set null,
  linked_pain_report_id uuid null
    references pilot.shadow_near_misses(near_miss_id) on delete set null,
  entered_in_error  boolean not null default false,
  recorded_by_account_id text not null,
  recorded_by_role  text not null,
  updated_by_account_id text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pilot_athlete_injuries_pkey primary key (organization_id, injury_id),
  constraint pilot_athlete_injuries_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_athlete_injuries_rtt_plan_fk foreign key (organization_id, linked_rtt_plan_id)
    references pilot.return_to_training_plans(organization_id, plan_id),
  constraint pilot_athlete_injuries_hold_fk foreign key (organization_id, linked_hold_id)
    references pilot.training_holds(organization_id, hold_id),
  constraint pilot_athlete_injuries_return_after_injury check (
    (expected_return_date is null or expected_return_date >= injury_date)
    and (returned_on is null or returned_on >= injury_date)),
  constraint pilot_athlete_injuries_one_return_source check (
    linked_rtt_plan_id is null or expected_return_date is null)
);

create index if not exists idx_athlete_injuries_athlete
  on pilot.athlete_injuries(organization_id, athlete_id, injury_date desc);
