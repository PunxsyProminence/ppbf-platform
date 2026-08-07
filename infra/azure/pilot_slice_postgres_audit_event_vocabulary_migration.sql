-- PPBF Pilot Audit Event Vocabulary Migration
-- Safe, additive, idempotent migration for existing pilot schema installations.
--
-- Widens pilot.audit_events.event_type to admit
-- 'shadow_research_upload_requirement', which the application has been sending
-- since the SHADOW research-requirement upload path was built but the constraint
-- never allowed.
--
-- THE BUG THIS FIXES, concretely: apps/web/app/api/pilot/shadow/upload/route.ts
-- classifies an upload as a research requirement, writes the requirement row,
-- and then calls writePilotAuditEvent with event_type
-- 'shadow_research_upload_requirement'. writePilotAuditEvent does not catch, so
-- the insert failed with SQLSTATE 23514 (check_violation on
-- audit_events_event_type_check) and the error propagated -- failing the request
-- after the file had already been stored and the requirement row committed. The
-- upload half succeeded, the audit half could never succeed, and the caller saw
-- a 500.
--
-- The vocabulary is now declared once, in
-- apps/web/src/server/pilot/auditEventTypes.ts, and
-- auditEventVocabulary.test.ts asserts this file agrees with it. Adding a value
-- to one side without the other fails that test.
--
-- SAFE ROLLOUT ORDER (this repository's deploy workflows do not apply
-- migrations automatically -- run this by hand, per environment, before
-- deploying the application code from this change).
--
-- Fresh installation:
--   1. Apply the canonical base schema
--        npm run --workspace apps/web pilot:apply-schema
--   2. Do NOT run this migration -- pilot_slice_postgres.sql already declares
--      the full vocabulary directly.
--   3. Deploy the application code.
--
-- Existing installation:
--   1. Apply THIS migration
--        npm run --workspace apps/web pilot:apply-audit-event-vocabulary
--   2. Deploy the application code.
--
-- Applying this migration before deploying is safe on its own: widening a check
-- constraint cannot reject any row the old constraint accepted, so currently
-- deployed code keeps working unchanged if the deploy is delayed or rolled back.

-- No explicit begin/commit here: pilot-apply-audit-event-vocabulary-migration.mjs
-- wraps this file in a single transaction itself, matching the other migration
-- scripts in this repository. Opening a second one would nest, and the inner
-- commit would end the outer transaction early.

alter table pilot.audit_events
  drop constraint if exists audit_events_event_type_check;

alter table pilot.audit_events
  add constraint audit_events_event_type_check
  check (event_type in (
    'create',
    'update',
    'login',
    'logout',
    'shadow_classification',
    'shadow_routing',
    'shadow_research_upload_requirement',
    'data_deletion_initiated',
    'data_purged'
  ));

comment on column pilot.audit_events.event_type is
  'Canonical audit event vocabulary. The authoritative list lives in apps/web/src/server/pilot/auditEventTypes.ts; auditEventVocabulary.test.ts asserts this constraint matches it.';
