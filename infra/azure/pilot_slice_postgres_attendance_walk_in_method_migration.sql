-- Attendance check-in method vocabulary (pilot.scheduler_attendance) -- admit
-- 'walk_in' as its own value.
--
-- WHY
--
-- OD-2026-10-07-008 (question card 1 item 4, "Whole class plus walk-ins"):
-- the coach who teaches, scheduled, or is covering a class takes its whole
-- register, and may mark PRESENT an athlete of the gym who turned up without
-- registering. That mark is a different fact from "signed up and came": no
-- registration row exists for the athlete, the seat count never included
-- them, and a roster read has to be able to tell the two apart. `method` is
-- the one durable record of how an attendance mark was made, so the fact
-- goes there -- not into `note` (free text a coach typed about a child, which
-- is not a flag) and not as an invented registration (which would ride
-- capacity, waitlisting and the all-training-hold refusal that registration
-- carries and a check-in, by OD-2026-10-06-024 ruling 1, does not).
--
-- Same shape as pilot_slice_postgres_attendance_parent_method_migration.sql,
-- which widened the same constraint for 'parent' on the same ground: store
-- what happened instead of picking the nearest existing lie.
--
-- WHAT IS NOT TOUCHED
--
-- No existing row changes. Nothing before this migration could have stored a
-- walk-in: the route refused an unregistered athlete outright.
--
-- APPLY
--
-- Idempotent. Runs in the transaction that
-- apps/web/scripts/pilot-apply-attendance-walk-in-method-migration.mjs opens.
-- The constraint name is the one the parent-method migration left behind
-- (pilot_scheduler_attendance_method_check); the base schema's own unnamed
-- check is dropped by its auto-generated name in case this runs on a
-- database the parent-method migration never reached.

do $pilot_scheduler_attendance_walk_in_method$
begin
  alter table pilot.scheduler_attendance
    drop constraint if exists scheduler_attendance_method_check;
  alter table pilot.scheduler_attendance
    drop constraint if exists pilot_scheduler_attendance_method_check;
  alter table pilot.scheduler_attendance
    add constraint pilot_scheduler_attendance_method_check
    check (method in ('self', 'parent', 'coach_override', 'admin_override', 'walk_in'));
end
$pilot_scheduler_attendance_walk_in_method$;
