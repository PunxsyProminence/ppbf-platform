-- Indexes for the email alert sweep's reads by time (lane W4-1, EM-IX).
--
-- WHAT WAS MISSING. The email alert sweep (EM-3b-1's tick, EM-4a's sources)
-- reads each event table for the rows created since its checkpoint, less a
-- ten-minute overlap: `created_at > $2 and created_at <= $3`. It runs on every
-- worker tick (every 30 seconds by default), on every replica. Neither table
-- it reads has an index that starts with created_at:
--   - pilot.safety_escalations has (organization_id, status, created_at desc)
--     and (organization_id, athlete_id, created_at desc)
--     (pilot_slice_postgres.sql, pilot_slice_postgres_safety_escalations_migration.sql);
--   - pilot.family_message_replies has only (organization_id, note_id,
--     created_at) (pilot_slice_postgres_family_message_replies_migration.sql).
-- EM-4a's reviewer measured it on embedded PostgreSQL 18.4 with 100,000 rows
-- per table: the reply read was a full sequential scan, and the escalation
-- read an index skip scan, which PostgreSQL before 18 does not have. Each read
-- grows with its whole table, not with what is new.
--
-- WHAT THIS DOES. One b-tree on created_at for each table, so the sweep reads
-- only the rows in its window. Additive only: no table altered, no row
-- touched, nothing dropped. App Overwatch's answer A on #2159 (comment
-- 7157968713): an index-only migration in its own PR, no data change.
--
-- FORM. Plain `create index`, not CONCURRENTLY: every pilot:apply-* runner in
-- this repository applies its file inside one BEGIN/COMMIT, and PostgreSQL
-- refuses CREATE INDEX CONCURRENTLY inside a transaction block. Same form as
-- pilot_slice_postgres_audit_events_entity_index_migration.sql. Each build
-- takes a SHARE lock on its table, and both locks are held until the one
-- COMMIT: reads continue, writes (a new escalation, a parent's reply) wait.
-- `if not exists` does not avoid the lock, so a re-run under `all` takes it
-- too. Two things bound the wait:
--   - the replies index is built first, so while the runner waits for the
--     replies table it holds nothing on pilot.safety_escalations, and safety
--     escalations go on being written;
--   - the runner sets lock_timeout to 10 seconds, so behind a long
--     transaction it gives up and rolls back rather than queue, and the
--     operator re-runs in a quieter moment.
-- The tables' production row counts are not known from the repository.
--
-- Idempotent: `if not exists` makes a re-run under `all` a no-op for the
-- schema (it still takes the locks, as FORM says). Depends on
-- the base schema (pilot.safety_escalations) and the family-message-replies
-- migration (pilot.family_message_replies); the guard below names a missing
-- table rather than failing inside the create. No begin;/commit; here,
-- matching the runner-opens-the-transaction convention; the runner is
-- apps/web/scripts/pilot-apply-email-alert-sweep-indexes-migration.mjs.

do $pilot_email_alert_sweep_indexes$
begin
  if to_regclass('pilot.safety_escalations') is null then
    -- No "--" inside the strings: pilot-verify-schema.mjs strips comments
    -- without regard to quotes and would eat the closing quote.
    raise exception 'EMAIL_ALERT_SWEEP_INDEXES_NOT_READY: pilot.safety_escalations does not exist; apply the base schema first';
  end if;
  if to_regclass('pilot.family_message_replies') is null then
    raise exception 'EMAIL_ALERT_SWEEP_INDEXES_NOT_READY: pilot.family_message_replies does not exist; apply the family-message-replies migration first';
  end if;
end
$pilot_email_alert_sweep_indexes$;

-- Replies first: see FORM above.
create index if not exists idx_pilot_family_message_replies_created_at
  on pilot.family_message_replies (created_at);

create index if not exists idx_pilot_safety_escalations_created_at
  on pilot.safety_escalations (created_at);
