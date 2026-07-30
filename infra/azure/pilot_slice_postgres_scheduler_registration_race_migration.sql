-- Backstop for the scheduler registration race: the app-level flow now locks
-- the class row before checking/inserting (see registerForClassTransactionally
-- in schedulerDb.ts), but this partial unique index guarantees the invariant
-- at the database level too, independent of any future app-code regression.
-- Additive only -- no existing table altered, no data touched.
create unique index if not exists idx_scheduler_registrations_unique_active
  on pilot.scheduler_registrations(organization_id, class_id, athlete_id)
  where status <> 'cancelled';
