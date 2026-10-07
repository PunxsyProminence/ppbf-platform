-- Calibration re-mark passes (pilot.calibration_annotation_sets.pass_number)
-- -- one annotator may label the same clip again, blind, in a later session.
--
-- STACKED ON the calibration annotations migration, and on the adjudication
-- migration for the last block.
--
-- WHAT CHANGES. The annotations migration allowed one set per annotator per
-- clip, so a repeat reading could only come from a second person. A set now
-- carries a pass number, and the key becomes one set per annotator per clip
-- PER PASS. Every existing row is pass 1 by the column default; nothing is
-- rewritten.
--
-- WHAT DOES NOT CHANGE. Pass 1 is the reading every comparison, adjudication,
-- agreement figure and gold record is built from, and there is still exactly
-- one of those per annotator per clip. A later pass is a separate measurement
-- (the same person against themselves) and is never one side of an
-- inter-annotator pair -- enforced below for adjudications, which gold
-- records can only be built from.
--
-- A LATER PASS OPENS ONLY ON A FINISHED ONE. Pass N needs the same
-- annotator's pass N-1 on the same clip to be submitted. Two passes open at
-- once would be one reading written twice, side by side.
--
-- WHAT THE DATABASE CANNOT DO HERE. Blindness between a person's own passes
-- is a property of READS, and lives in the application (annotatorGate.ts,
-- calibration/blinding.ts). This file makes the passes distinguishable and
-- ordered; it cannot stop a SELECT.
--
-- Additive and idempotent, with one deliberate removal: the three-column
-- unique key is dropped once the four-column key that replaces it exists. No
-- `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-remark-pass-migration.mjs) opens
-- the transaction itself.

alter table pilot.calibration_annotation_sets
  add column if not exists pass_number integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.calibration_annotation_sets')
      and conname = 'pilot_calibration_sets_pass_number_positive'
  ) then
    alter table pilot.calibration_annotation_sets
      add constraint pilot_calibration_sets_pass_number_positive
      check (pass_number >= 1);
  end if;

  -- ONE SET PER ANNOTATOR PER CLIP PER PASS. Added before the old key goes,
  -- so there is no statement after which neither holds.
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.calibration_annotation_sets')
      and conname = 'pilot_calibration_sets_one_per_annotator_pass_uq'
  ) then
    alter table pilot.calibration_annotation_sets
      add constraint pilot_calibration_sets_one_per_annotator_pass_uq
      unique (organization_id, calibration_clip_id, annotator_account_id, pass_number);
  end if;
end
$$;

-- The annotations migration declares this key inline in its CREATE TABLE and
-- nowhere else, so re-running that migration does not put it back.
alter table pilot.calibration_annotation_sets
  drop constraint if exists pilot_calibration_sets_one_per_annotator_uq;

-- ---------------------------------------------------------------------------
-- A pass keeps its number, and a later pass stands on a finished one.
--
-- Its own function and trigger rather than an edit to
-- pilot.calibration_annotation_sets_freeze: the `all` sequence re-runs the
-- annotations migration, whose CREATE OR REPLACE would silently undo an edit
-- made here.
--
-- The existing freeze pins annotator and clip only once a set is SUBMITTED.
-- A later pass is pinned from the start: moved to another annotator or clip
-- while in progress, it would be a pass 2 with no pass 1 under it.
--
-- DELETES ARE NOT GUARDED, on purpose. A clip, a video or an organization
-- being deleted takes every pass with it, and nothing here may stand in the
-- way of a data-deletion request.
-- ---------------------------------------------------------------------------
create or replace function pilot.calibration_annotation_sets_pass_guard()
returns trigger
language plpgsql
as $pilot_calibration_sets_pass_guard$
declare
  previous_status text;
begin
  if tg_op = 'UPDATE' then
    if new.pass_number is distinct from old.pass_number
       or (old.pass_number > 1
         and (new.organization_id is distinct from old.organization_id
           or new.annotator_account_id is distinct from old.annotator_account_id
           or new.calibration_clip_id is distinct from old.calibration_clip_id))
    then
      raise exception 'CALIBRATION_ANNOTATION_SET_PASS_FIXED'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if new.pass_number > 1 then
    select status into previous_status
      from pilot.calibration_annotation_sets
     where organization_id = new.organization_id
       and calibration_clip_id = new.calibration_clip_id
       and annotator_account_id = new.annotator_account_id
       and pass_number = new.pass_number - 1;

    -- Absent and unfinished are refused alike: null is distinct from
    -- 'submitted'.
    if previous_status is distinct from 'submitted' then
      raise exception 'CALIBRATION_ANNOTATION_SET_PREVIOUS_PASS_NOT_SUBMITTED'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$pilot_calibration_sets_pass_guard$;

drop trigger if exists pilot_calibration_sets_pass_guard
  on pilot.calibration_annotation_sets;
create trigger pilot_calibration_sets_pass_guard
  before insert or update on pilot.calibration_annotation_sets
  for each row
  execute function pilot.calibration_annotation_sets_pass_guard();

-- ---------------------------------------------------------------------------
-- An adjudication settles two FIRST passes.
--
-- pilot_calibration_adjudications_two_sets and
-- pilot_calibration_gold_two_annotators both check only that the two set ids
-- differ. That meant "two different people" because one person could hold one
-- set per clip. With the key above widened it would no longer follow, so it
-- is stated here: both sets are pass 1, and pass 1 is unique per annotator
-- per clip. Gold records reach their sets only through an adjudication, so
-- they inherit it.
--
-- Created only where the adjudications table exists, as the annotations
-- migration does for the clips bounds key. The runner's readiness check
-- requires the trigger, so a real apply cannot end without it.
-- ---------------------------------------------------------------------------
create or replace function pilot.calibration_adjudications_first_pass_guard()
returns trigger
language plpgsql
as $pilot_calibration_adjudications_first_pass_guard$
begin
  if exists (
    select 1
      from pilot.calibration_annotation_sets s
     where s.organization_id = new.organization_id
       and s.annotation_set_id in (new.annotation_set_id_a, new.annotation_set_id_b)
       and s.pass_number <> 1
  ) then
    raise exception 'CALIBRATION_ADJUDICATION_NOT_FIRST_PASS'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$pilot_calibration_adjudications_first_pass_guard$;

do $$
begin
  if to_regclass('pilot.calibration_adjudications') is not null then
    drop trigger if exists pilot_calibration_adjudications_first_pass_guard
      on pilot.calibration_adjudications;
    create trigger pilot_calibration_adjudications_first_pass_guard
      before insert or update on pilot.calibration_adjudications
      for each row
      execute function pilot.calibration_adjudications_first_pass_guard();
  end if;
end
$$;
