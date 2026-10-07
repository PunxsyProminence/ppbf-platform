-- An index for reading pilot.audit_events by the record it is about.
--
-- WHAT WAS MISSING. pilot.audit_events had two indexes, both by time:
-- idx_pilot_audit_events_created_at and idx_pilot_audit_events_org_created_at
-- (pilot_slice_postgres.sql). #1286 (CL-A8) made notice authorship a lookup
-- against the audit stream -- "the actor on the notice's 'create' row" --
-- filtering by (organization_id, entity_type, entity_id) in
-- announcements.ts (setAnnouncementActive, listAuthoredAnnouncementIds), and
-- audit/get filters by the same columns when a reader asks for one entity.
-- Neither index serves that shape; every such read walks the organization's
-- whole audit history, and that history only grows.
--
-- WHAT THIS DOES. One b-tree on (organization_id, entity_type, entity_id),
-- the columns those reads bind, in the order they bind them, so the
-- organization prefix alone is usable too. Additive only: no table altered,
-- no row touched, nothing dropped.
--
-- FORM. Plain `create index`, not CONCURRENTLY: every pilot:apply-* runner in
-- this repository applies its file inside one BEGIN/COMMIT (the runner opens
-- the transaction and checks readiness before committing), and PostgreSQL
-- refuses CREATE INDEX CONCURRENTLY inside a transaction block. The plain
-- form holds a SHARE lock on pilot.audit_events for the duration of the
-- build: reads continue, inserts (every audited write) wait. The table's
-- production row count is not known from the repository; the lock lasts for
-- one index build over it. Same form as the only other index-only migration
-- here, pilot_slice_postgres_scheduler_registration_race_migration.sql.
--
-- Idempotent: `if not exists` makes a re-run under `all` a no-op. Depends on
-- the base schema only (pilot.audit_events); the guard below names the
-- missing table rather than failing inside the create. No begin;/commit;
-- here, matching the runner-opens-the-transaction convention; the runner is
-- apps/web/scripts/pilot-apply-audit-events-entity-index-migration.mjs.

do $pilot_audit_events_entity_index$
begin
  if to_regclass('pilot.audit_events') is null then
    raise exception 'AUDIT_EVENTS_ENTITY_INDEX_NOT_READY: pilot.audit_events does not exist -- apply the base schema first';
  end if;
end
$pilot_audit_events_entity_index$;

create index if not exists idx_pilot_audit_events_org_entity
  on pilot.audit_events (organization_id, entity_type, entity_id);
