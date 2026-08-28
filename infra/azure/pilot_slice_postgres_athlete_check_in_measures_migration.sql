-- Athlete check-in: the measures the extended check-in collects.
--
-- Owner decision (2026-08-28). pilot.athlete_check_ins shipped with three
-- wellness self-reports (energy, soreness, focus). The athlete panel that was
-- built to write them offers a different set -- sleep, hydration, motivation,
-- soreness -- and stored none of it, because the panel wrote to local React
-- state only. The owner's call was that the BACKEND moves to the panel, and
-- that the table grows by named columns, one migration per measure decided,
-- rather than by an untyped blob. This migration is that growth for the six
-- measures approved in this pass.
--
-- WHAT THIS ADDS. Six nullable columns, all optional, all absent-by-default:
--
--   sleep_hours           hours slept, a QUANTITY (numeric), not a rating
--   hydration             1-5 self-report
--   motivation            1-5 self-report
--   mental_clarity        1-5 self-report
--   stress                1-5 self-report
--   nutrition_compliance  1-5 self-report
--
-- Skipping any of them stays legal, exactly as it already is for energy,
-- soreness and focus: absent is absent, and no default is invented. A bare
-- check-in with every field null is still a valid "I'm here".
--
-- WHY 1-5 AND NOT THE PANEL'S 1-10. The three shipped columns carry
-- `check (... between 1 and 5)` and are live in production (apply-migrations
-- run 33089360578, MIGRATION=all, TARGET=production, 2026-08-27). Widening
-- them to 1-10 would leave any row already stored with its `3` silently
-- reinterpreted from three-out-of-five to three-out-of-ten. That is the same
-- class of defect as
-- pilot_slice_postgres_session_rpe_semantics_migration.sql -- a number whose
-- meaning changed without the row saying so -- and it is avoided the same way:
-- nothing already stored is touched, and the new columns join the scale that
-- is already there. What each of 1..5 MEANS is recorded in
-- apps/web/src/shared/wellnessScales.ts, which the server validates against
-- and the athlete's screen labels from, so the anchor a child reads and the
-- number in the column cannot drift apart.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD, AND WHY. Three measures the athlete
-- panel advertises under "here is what is coming" are NOT columns here,
-- because each already has an owner and a second home would be a second
-- answer:
--
--   * RPE. pilot.sessions.rpe (+ rpe_method) owns it, and it is a POST-session
--     construct. The check-in flow writing a pre-session number into it is the
--     precise defect
--     pilot_slice_postgres_session_rpe_semantics_migration.sql was written to
--     end -- it cost a child being told "effort 8 of 10" for a session they
--     did not train. Collecting RPE on a pre-training form would rebuild it.
--   * Training load. pilot.session_load owns it, splits it physical /
--     cognitive, and states that derived load "is computed in the query, never
--     stored -- the formula is unvalidated in boxing". A self-reported load
--     field here would be a third definition.
--   * Soreness by location. The athlete pain card already writes this, to
--     /api/pilot/shadow/formulas/observations as kind 'pain_report', and that
--     path ESCALATES -- the UI tells the child a coach has been told. A
--     duplicate wellness column would take the same report and tell nobody.
--
-- Resting heart rate, HRV and blood pressure are deferred by the same owner
-- decision, not forgotten: they are health/biometric readings on minors, a
-- different class from "how sore are you", and they get their own slice once
-- consent and retention are settled. Per the owner's growth model, each
-- arrives as its own named column in its own migration.
--
-- Idempotent: add column if not exists, catalog-guarded constraints, no
-- drops, no destructive alters, no existing value altered.
-- No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-athlete-check-in-measures-migration.mjs).

alter table pilot.athlete_check_ins
  add column if not exists sleep_hours numeric(3,1) null;

alter table pilot.athlete_check_ins
  add column if not exists hydration integer null;

alter table pilot.athlete_check_ins
  add column if not exists motivation integer null;

alter table pilot.athlete_check_ins
  add column if not exists mental_clarity integer null;

alter table pilot.athlete_check_ins
  add column if not exists stress integer null;

alter table pilot.athlete_check_ins
  add column if not exists nutrition_compliance integer null;

-- The constraints are added separately from the columns, catalog-guarded, so
-- a re-run over an environment that already has the columns still converges
-- on having the checks. `add column ... check (...)` would skip the check
-- entirely whenever the column already existed.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_sleep_hours_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_sleep_hours_check
      check (sleep_hours is null or sleep_hours between 0 and 24);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_hydration_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_hydration_check
      check (hydration is null or hydration between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_motivation_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_motivation_check
      check (motivation is null or motivation between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_mental_clarity_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_mental_clarity_check
      check (mental_clarity is null or mental_clarity between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_stress_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_stress_check
      check (stress is null or stress between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_athlete_check_ins_nutrition_compliance_check'
      and conrelid = to_regclass('pilot.athlete_check_ins')
  ) then
    alter table pilot.athlete_check_ins
      add constraint pilot_athlete_check_ins_nutrition_compliance_check
      check (nutrition_compliance is null or nutrition_compliance between 1 and 5);
  end if;
end
$$;

comment on column pilot.athlete_check_ins.sleep_hours is
  'Hours the athlete reports sleeping, 0-24, one decimal. A quantity, not a 1-5 rating -- deliberately not given anchor text, because hours are measured and ratings are judged. NULL means not reported.';

comment on column pilot.athlete_check_ins.hydration is
  'Athlete self-report, 1-5, higher is better. Anchors in apps/web/src/shared/wellnessScales.ts. NULL means not reported -- never 0, never a default.';

comment on column pilot.athlete_check_ins.motivation is
  'Athlete self-report, 1-5, higher is better. Anchors in apps/web/src/shared/wellnessScales.ts. NULL means not reported -- never 0, never a default.';

comment on column pilot.athlete_check_ins.mental_clarity is
  'Athlete self-report, 1-5, higher is better. Anchors in apps/web/src/shared/wellnessScales.ts. NULL means not reported -- never 0, never a default.';

comment on column pilot.athlete_check_ins.stress is
  'Athlete self-report, 1-5, higher is WORSE -- 5 is a bad day, not a good one. Direction is recorded in apps/web/src/shared/wellnessScales.ts so an aggregate cannot silently average it against the higher-is-better columns. NULL means not reported.';

comment on column pilot.athlete_check_ins.nutrition_compliance is
  'Athlete self-report, 1-5, higher is better. Anchors in apps/web/src/shared/wellnessScales.ts. NULL means not reported -- never 0, never a default.';
