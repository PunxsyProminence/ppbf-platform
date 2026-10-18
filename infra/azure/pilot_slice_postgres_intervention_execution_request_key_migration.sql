-- Intervention executions: a request key, so one tap logs one intervention.
--
-- WHY. The live session screen logs an intervention with one POST to
-- /api/pilot/coach/intervention-executions. When that POST gets no clear answer
-- (a gateway timeout while the app is still working), the screen reads the
-- ledger back to see whether the record is there (lane L40, #1707). A read that
-- finds nothing does not prove a write still in flight will not commit after
-- it, so the coach is told "not logged, try again" and the retry can log the
-- same intervention twice (finding F-135). A request key closes that: the
-- screen makes one random id for one tap and sends the same id again on a
-- retry, and a second send of that id returns the first record instead of
-- writing another. This is the request key pilot.workout_issues already has
-- (pilot_slice_postgres_workout_issues_migration.sql), with the same limits.
--
-- WHAT CHANGES. One column on pilot.intervention_executions:
--   request_key -- the id the caller's screen sent with the POST that started
--                  this execution, or NULL when it sent none. Existing rows,
--                  and every row a caller without a key starts, stay NULL, and
--                  nothing is compared for them.
-- One check: a key, when present, is not blank and at most 200 characters.
-- One partial unique index: a key names at most one execution in an
-- organization. A correction writes a new row naming its columns
-- (interventionExecutions.ts correctExecution) and never copies the key, so the
-- key stays on the row the tap started.
--
-- Requires pilot.intervention_executions
-- (pilot_slice_postgres_intervention_executions_migration.sql); the `all` chain
-- runs it first.
--
-- Idempotent: add column if not exists; the check is added only when this table
-- has no check of that name, so a re-run (the `all` chain) does not re-scan the
-- table under an exclusive lock; create index if not exists. A same-named check
-- or index with any other definition is left for the runner's readiness check to
-- refuse. Additive only: nothing is dropped. No
-- `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-intervention-execution-request-key-migration.mjs)
-- opens the transaction.

alter table pilot.intervention_executions
  add column if not exists request_key text null;

do $pilot_intervention_executions_request_key_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_intervention_executions_request_key_check'
      and conrelid = to_regclass('pilot.intervention_executions')
  ) then
    alter table pilot.intervention_executions
      add constraint pilot_intervention_executions_request_key_check check (
        request_key is null or (length(btrim(request_key)) > 0 and length(request_key) <= 200)
      );
  end if;
end
$pilot_intervention_executions_request_key_check$;

create unique index if not exists pilot_intervention_executions_one_per_request_key
  on pilot.intervention_executions(organization_id, request_key)
  where request_key is not null;

comment on column pilot.intervention_executions.request_key is
  'Random id the caller''s screen sent for one tap of Log intervention, or NULL when it sent none. Unique per organization when set (pilot_intervention_executions_one_per_request_key): a repeated send returns the execution it started instead of writing a second one. Never copied to a correction.';
