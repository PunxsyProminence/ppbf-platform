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
-- THE CATEGORY VOCABULARY OMITS THE TWO WEIGHT OPTIONS. THIS IS DELIBERATE
--
-- The dropdown today offers nine categories, two of which are 'Weight Loss'
-- and 'Weight Gain'. Seven are admitted below; those two are not, and the
-- dropdown drops them in the same change so that no athlete can choose a value
-- the database will refuse.
--
-- The reasoning is sequencing, not squeamishness. Body composition is Group J
-- of the capability plan, and the plan places it in Phase 7 explicitly behind
-- the Privacy-Tier System (capability 200), which is Phase 1 work that has not
-- been built. Admitting these two values here would create a stored, queryable
-- record of a minor's weight-loss intent -- readable by every role the goals
-- list is readable by -- ahead of the tier system whose entire job is to decide
-- who may see exactly that. SHADOW already refuses weight-cutting guidance, and
-- the plan names repeated weight questions as a red-flag escalation signal; it
-- would be strange for the doctrine layer to refuse the conversation while the
-- goals table quietly filed the goal.
--
-- Nothing is lost by waiting: the category has never been persisted, so
-- choosing 'Weight Loss' has never had an effect. What replaces it on screen is
-- a line pointing the athlete at their coach, per the owner principle recorded
-- 2026-08-03 -- the stop carries the lesson, it is not just a wall.
--
-- This is an owner decision, and it is a one-line reversal in each of two
-- places (the check below and SMART_GOAL_CATEGORIES in AthleteWorkspace.tsx)
-- once the privacy tiers exist.
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
  -- The seven categories an athlete may file a goal under. See the header for
  -- why 'Weight Loss' and 'Weight Gain' are not among them yet. NULL stays
  -- admissible: it is what every goal written before this migration carries,
  -- and it means "no category was chosen", which is true of all of them.
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
      'Leadership'
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
