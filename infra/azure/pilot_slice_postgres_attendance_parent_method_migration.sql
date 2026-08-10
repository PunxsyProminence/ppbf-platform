-- Attendance check-in method vocabulary (pilot.scheduler_attendance) -- admit
-- 'parent' as its own value instead of silently relabeling it.
--
-- WHAT WAS BROKEN
--
-- app/api/pilot/scheduler/route.ts's attendance_checkin action resolves the
-- stored `method` with:
--
--   const method = isSelf ? 'self' : canManageAll(actor) ? 'admin_override' : 'coach_override';
--
-- A parent marking their own child present/absent/excused is neither the
-- athlete (`isSelf`) nor an admin (`canManageAll`), so every parent check-in
-- fell into the `else` branch and was written to the database as
-- `coach_override` -- attributing the action to a role that did not perform
-- it, in `checked_in_by_role` alongside a `checked_in_by_account_id` that is
-- in fact the parent's own account. `assertCanActOnAthlete` already permits a
-- parent to check in their own linked child (via `assertActorCanAccessAthlete`
-- in access.ts), so this is a live, reachable mislabeling, not a theoretical
-- one.
--
-- The database's own CHECK constraint made the honest fix impossible without
-- a migration: `method` only ever admitted `('self', 'coach_override',
-- 'admin_override')`. This file widens it to a fourth value, 'parent', so the
-- code fix (apps/web/app/api/pilot/scheduler/route.ts) can store what
-- actually happened instead of picking the nearest existing lie.
--
-- WHY THIS MATTERS BEYOND BOOKKEEPING
--
-- `method` is the only durable record of who actually made an attendance
-- call. An escalation, a dispute over a missed session, or a future coach
-- compliance review (#116) that reads this column needs to distinguish "a
-- parent said their child was here" from "a coach overrode the roster" --
-- those carry different evidentiary weight, and conflating them is exactly
-- the kind of silent-truth gap the 2026-07-31 audit was written to close.
--
-- EXISTING ROWS ARE UNTOUCHED, DELIBERATELY
--
-- Every `coach_override` row written by a parent before this migration stays
-- `coach_override`. There is no way to distinguish, after the fact, which
-- historical `coach_override` rows were actually parents -- `checked_in_by_role`
-- on those rows already correctly says 'parent' (that column was never wrong;
-- only `method` was), so a report that needs to know can already join on
-- `checked_in_by_role = 'parent'` for history. Rewriting `method` retroactively
-- would be inventing certainty about which historical rows to touch that this
-- migration does not have.
--
-- THE CHECK RECONCILES RATHER THAN GUARDS, matching the goal-category-progress
-- and rabbit-holes convention: the DO block drops and re-adds the constraint,
-- making this file the single source of truth on every run. Re-running is a
-- no-op.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-attendance-parent-method-migration.mjs) opens
-- the transaction itself.

do $pilot_scheduler_attendance_method$
begin
  -- The original inline `check (...)` in both pilot_slice_postgres.sql and
  -- pilot_slice_postgres_scheduler_tables_migration.sql was unnamed, so
  -- Postgres auto-named it `scheduler_attendance_method_check` (table_column
  -- convention). Drop that name on a first run, and our own re-run name on
  -- every run after, so this file is idempotent regardless of which shape the
  -- target database is currently in.
  alter table pilot.scheduler_attendance
    drop constraint if exists scheduler_attendance_method_check;
  alter table pilot.scheduler_attendance
    drop constraint if exists pilot_scheduler_attendance_method_check;
  alter table pilot.scheduler_attendance
    add constraint pilot_scheduler_attendance_method_check
    check (method in ('self', 'parent', 'coach_override', 'admin_override'));
end
$pilot_scheduler_attendance_method$;
