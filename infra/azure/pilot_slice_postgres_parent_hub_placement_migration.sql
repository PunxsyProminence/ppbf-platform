-- Parent Hub placement for pilot.announcements.
--
-- The placement vocabulary named four surfaces and none of them was the
-- parent hub, so 'everywhere' was the only placement a parent ever saw. An
-- author who wanted to reach guardians had to shout gym-wide, and an author
-- who targeted the athlete or coach workspace bypassed parents entirely.
-- Both authoring surfaces said so out loud in their own copy. This migration
-- adds 'parent_hub' so a notice or a chalk line can be addressed to
-- guardians on their own surface.
--
-- Widening a closed vocabulary means replacing the check constraint:
-- PostgreSQL cannot alter a check in place. The original constraint is
-- catalog-guarded BY NAME in
-- pilot_slice_postgres_announcement_placements_migration.sql, so after this
-- file re-creates the constraint under the same name, re-running that
-- earlier migration is a no-op rather than a downgrade back to four values.
-- DROP IF EXISTS + ADD is idempotent as a pair, and the re-add revalidates
-- existing rows, all of which carry values from the old set -- a subset of
-- the new one.
--
-- DEPENDS ON pilot_slice_postgres_announcement_placements_migration.sql
--
-- This file only replaces a constraint that migration creates, and the `all`
-- loop orders it after `announcement-placements`. Dispatching
-- `parent-hub-placement` alone against a fresh environment requires
-- `announcements` and then `announcement-placements` first.
--
-- No `begin;`/`commit;`: the runner
-- (apps/web/scripts/pilot-apply-parent-hub-placement-migration.mjs) opens
-- the transaction itself, matching the announcement-placements runner.

alter table pilot.announcements
  drop constraint if exists pilot_announcements_placement_check;

alter table pilot.announcements
  add constraint pilot_announcements_placement_check
  check (placement in ('gym_notices', 'athlete_workspace', 'coach_workspace', 'parent_hub', 'everywhere'));
