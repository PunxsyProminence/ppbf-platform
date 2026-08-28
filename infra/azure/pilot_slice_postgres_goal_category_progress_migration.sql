-- Goal category and progress (pilot.goals) -- give two fields the athlete
-- screen has always displayed somewhere to actually live.
--
-- WHAT WAS BROKEN, AND IT WAS BOTH HALVES
--
-- apps/web/components/AthleteWorkspace.tsx reads `category` and
-- `progress_percent` off every row returned by /api/pilot/goals/list. Neither
-- column existed. The list route is `select * from pilot.goals`, so both came
-- back undefined on every goal that has ever been created, and the component
-- substituted for them:
--
--   category:        `item.category || 'Boxing'`      (:623)
--   progressPercent: `item.progress_percent || 0`     (:626)
--
-- So the screen showed every goal in the gym as a Boxing goal at 0%, and the
-- progress bar at :1839 drew its width from that zero. That is a rendered
-- affordance over a number nothing holds -- the same defect class as the
-- invented /audit events and the fabricated capability rows, in a surface an
-- athlete reads about their own training.
--
-- The category half was worse than the storage gap suggests. The create form
-- at :1747 asks the athlete to choose a category and stores the choice in
-- React state, but `handleCreateGoal` never put it in the request body -- and
-- could not have: validateGoalPayload calls assertOnlyAllowedKeys, so a
-- `category` key would have been rejected as an unknown field. The dropdown
-- has therefore never done anything. An athlete picked "Academics", watched the
-- optimistic row appear with "Academics" on it, and found "Boxing" after the
-- next reload.
--
-- BOTH COLUMNS ARE NULLABLE, AND THAT IS THE POINT
--
-- The obvious shape is `not null default 'Boxing'` and `not null default 0`.
-- Both defaults would be lies about rows that already exist. Every goal in
-- staging and production predates this file: none of them carries a category
-- anyone chose, and none carries progress anyone reported. Backfilling 'Boxing'
-- would attribute a category to an athlete who never picked one, and
-- backfilling 0 would state that a real person has made no progress toward
-- their goal -- which is not "unknown", it is a specific and possibly false
-- claim about a child's training.
--
-- NULL is the honest value for both, and it is the value every pre-existing
-- row keeps. The read path renders it as uncategorised and as untracked
-- progress rather than as a category and a zeroed bar. "Unavailable" is an
-- acceptable state here; fabrication is not (standing owner instruction,
-- 2026-07-31).
--
-- THE TWO WEIGHT OPTIONS ARE NOW ADMITTED (owner decision, 2026-08-28)
--
-- This migration shipped with seven categories. 'Weight Loss' and 'Weight
-- Gain' were withheld, and the reason was a WAIT on a named gate rather than
-- a permanent refusal:
--
--   "Admitting these two values here would create a stored, queryable record
--    of a minor's weight-loss intent -- readable by every role the goals list
--    is readable by -- ahead of the tier system whose entire job is to decide
--    who may see exactly that."
--
-- That gate is built. Module 200, the Privacy-Tier System
-- (apps/web/src/server/pilot/privacyTiers.ts), ships FIELD_TIERS, whose own
-- entry for goals.category said the withholding "waits on an explicit owner
-- decision, which this registry makes possible and deliberately does not
-- make." The owner has now made it, for this surface and for the
-- coach-authored one in the same breath, so the two stop disagreeing about
-- the same subject: pilot.athlete_development_block_objectives admitted its
-- nutrition_body_composition domain on the same day.
--
-- WHAT DID NOT CHANGE, because a widened vocabulary is not a widened
-- audience:
--   * goals.category's tier is still athlete_record, and nothing about who
--     may READ a goal moved. This admits VALUES, not readers.
--   * shadowAuthority.ts still refuses 'weight_cut' in conversation. An
--     athlete may file their own goal; the model still gives no
--     weight-cutting guidance, and the plan itself is still built with a
--     coach.
--   * The form still says so. The line pointing a weight goal at the coach
--     and guardian is not deleted -- it is kept and shown when one of these
--     two categories is chosen, because the 2026-08-03 owner principle is
--     that the stop carries the lesson. What changes is that it is now
--     guidance beside a real choice rather than a wall in front of a missing
--     one.
--
-- REVERSING THIS COST MORE THAN THE OLD COMMENT PROMISED, and the promise is
-- corrected rather than left standing. This header said the reversal was "a
-- one-line reversal in each of two places", and contracts.ts said "one line
-- here, one in the migration, and one in SMART_GOAL_CATEGORIES". It was
-- SEVEN: this CHECK, contracts.ts#GOAL_CATEGORIES,
-- AthleteWorkspace.tsx#SMART_GOAL_CATEGORIES and the guidance line beside it,
-- validation.test.ts, goalCategoryProgress.pg.test.ts, athleteWorkspace.test.tsx,
-- and FIELD_TIERS' own note. Every one of those tests asserted the
-- WITHHOLDING, which is correct practice and is exactly why the count grew:
-- a decision guarded by tests costs the tests to reverse. Nobody was wrong to
-- write them; the estimate was wrong, and an estimate in a comment is a claim
-- like any other.
--
-- THE CHECK RECONCILES RATHER THAN GUARDS, for the reason the rabbit-holes
-- migration gives: this vocabulary is expected to grow, and a catalog-guarded
-- `if not exists` would leave an already-migrated environment rejecting the new
-- value forever. The DO block drops and re-adds, making this file the single
-- source of truth on every run. Re-running is a no-op -- the constraint that
-- results is identical -- and if a row somewhere violates a narrowed list the
-- ADD fails, the runner's transaction rolls back, and the previous constraint
-- is restored intact.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-goal-category-progress-migration.mjs) opens the
-- transaction itself, matching the drills / rabbit-holes / board-seats
-- convention.

alter table pilot.goals add column if not exists category text;
alter table pilot.goals add column if not exists progress_percent integer;

do $pilot_goals_category_progress$
begin
  -- The nine categories an athlete may file a goal under. 'Weight Loss' and
  -- 'Weight Gain' were withheld at first ship and admitted by owner decision
  -- 2026-08-28; see the header. NULL stays admissible: it is what every goal
  -- written before this migration carries, and it means "no category was
  -- chosen", which is true of all of them.
  alter table pilot.goals
    drop constraint if exists pilot_goals_category_check;
  alter table pilot.goals
    add constraint pilot_goals_category_check
    check (category is null or category in (
      'Boxing',
      'Fitness',
      'Academics',
      'Attendance',
      'Recovery',
      'Lifestyle',
      'Leadership',
      'Weight Loss',
      'Weight Gain'
    ));

  -- A percentage or nothing. NULL is untracked progress and renders as such;
  -- 0 is a real report that the athlete has not started, and the two must stay
  -- distinguishable or the bar goes back to inventing a number.
  alter table pilot.goals
    drop constraint if exists pilot_goals_progress_percent_check;
  alter table pilot.goals
    add constraint pilot_goals_progress_percent_check
    check (progress_percent is null or (progress_percent >= 0 and progress_percent <= 100));
end
$pilot_goals_category_progress$;
