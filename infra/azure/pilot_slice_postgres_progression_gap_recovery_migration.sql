-- Progression gap type vocabulary (pilot.progression_gaps) -- admit 'recovery'.
--
-- WHY
--
-- The change-trigger rule (training load up while wellness goes down) needs to
-- open a gap that says what it is: the athlete is not recovering from the work.
-- None of the six original types says that -- 'endurance' and 'mental' are the
-- nearest, and both would misfile it. Jason chose a new 'recovery' type over
-- reusing one (2026-10-04, lane "Change trigger: load up + wellness down":
-- "New 'recovery' type"). This file only widens the vocabulary; the rule that
-- writes it ships separately.
--
-- WHAT CHANGES
--
-- The original CHECK is inline and unnamed in
-- pilot_slice_postgres_progression_migration.sql, so Postgres auto-named it
-- `progression_gaps_gap_type_check`. That name is KEPT, not replaced:
-- rabbitHoles.pg.test.ts reads the gap_type vocabulary from the constraint by
-- that name, and every database -- old or migrated -- ends up with the same
-- one constraint under the same one name.
--
-- Existing rows are untouched; every value the old CHECK admitted is still
-- admitted, so the re-added constraint validates against them.
--
-- THE CHECK RECONCILES RATHER THAN GUARDS, matching the attendance-parent-method
-- and rabbit-holes convention: drop and re-add on every run, so this file is the
-- single source of truth for the vocabulary. Re-running is a no-op.
--
-- Requires pilot.progression_gaps (pilot_slice_postgres_progression_migration.sql);
-- the `all` chain runs `progression` first.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-progression-gap-recovery-migration.mjs) opens
-- the transaction itself.

do $pilot_progression_gap_type$
begin
  alter table pilot.progression_gaps
    drop constraint if exists progression_gaps_gap_type_check;
  alter table pilot.progression_gaps
    add constraint progression_gaps_gap_type_check
    check (gap_type in ('technique', 'strength', 'endurance', 'skill', 'mental', 'tactical', 'recovery'));
end
$pilot_progression_gap_type$;
