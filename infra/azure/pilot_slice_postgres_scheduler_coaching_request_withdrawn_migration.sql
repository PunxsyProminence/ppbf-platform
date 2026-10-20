-- Coaching-request status vocabulary (pilot.scheduler_coaching_requests) --
-- admit 'withdrawn' as its own value.
--
-- WHY
--
-- Parent portal walk 2026-10-19 item 9: an August coaching request nobody
-- answered read "not answered, and the preferred time has passed" on
-- /schedule with no way for the family to close it. Jason 2026-10-19, Q4
-- "A: Family can withdraw (Rec.)": a guardian may withdraw a pending request
-- for their child, an athlete one they made themselves. That is a different
-- fact from an admin's 'declined' (the gym said no), so it gets its own value
-- rather than borrowing the nearest existing one.
--
-- WHAT IS NOT TOUCHED
--
-- No existing row changes. Nothing before this migration could store
-- 'withdrawn'.
--
-- APPLY
--
-- Idempotent. Runs in the transaction that
-- apps/web/scripts/pilot-apply-scheduler-coaching-request-withdrawn-migration.mjs
-- opens. The base schema's check is unnamed, so it is dropped by its
-- auto-generated name and replaced by a named one, as the attendance-method
-- migrations did for pilot.scheduler_attendance.

do $pilot_scheduler_coaching_request_withdrawn$
begin
  alter table pilot.scheduler_coaching_requests
    drop constraint if exists scheduler_coaching_requests_status_check;
  alter table pilot.scheduler_coaching_requests
    drop constraint if exists pilot_scheduler_coaching_requests_status_check;
  alter table pilot.scheduler_coaching_requests
    add constraint pilot_scheduler_coaching_requests_status_check
    check (status in ('pending', 'approved', 'declined', 'withdrawn'));
end
$pilot_scheduler_coaching_request_withdrawn$;
