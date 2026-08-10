-- Data retention and deletion infrastructure
--
-- Adds soft-delete (deleted_at) tracking to tables holding minor data,
-- and cascade-deletion logic so that deleting a guardian also marks
-- all linked athletes for deletion.
--
-- Idempotent and safe to re-apply.
--
-- This file deliberately has NO outer `do $$ ... $$` wrapper. The first
-- version had one, and the plpgsql function body below is itself dollar-quoted:
-- the inner `$$` closed the outer block early and the whole migration died with
-- a syntax error at the function definition. Every statement here is already
-- idempotent on its own (`if not exists` / `or replace`), so the wrapper bought
-- nothing and cost the deployment.

-- --- pilot.accounts: track guardian/parent deletion ---
alter table pilot.accounts add column if not exists deleted_at timestamptz null;

-- --- pilot.athletes: track athlete withdrawal ---
alter table pilot.athletes add column if not exists deleted_at timestamptz null;

-- --- pilot.coach_observations: already cascade-deletes with athlete ---
-- (no change needed; constraint is already present)

-- --- Partial indexes: the active-record path, which is every read ---
create index if not exists idx_athletes_active_org
  on pilot.athletes(organization_id, athlete_id)
  where deleted_at is null;

create index if not exists idx_accounts_active_org
  on pilot.accounts(organization_id)
  where deleted_at is null;

-- --- Cascade deletion trigger: when a parent is deleted, mark their athletes ---
--
-- Why a trigger instead of a foreign key cascade: we want to SOFT-delete the
-- athletes (mark deleted_at, not remove the row), so the cascade is "when
-- accounts.deleted_at becomes NOT NULL, set athletes.deleted_at for all linked
-- athletes". A FK cascade would DELETE the rows outright, which discards them
-- before the retention window this migration exists to enforce.
--
-- The join runs accounts -> parents -> guardian_links, and that indirection is
-- the point. guardian_links.parent_id references pilot.parents(parent_id); it
-- is NOT an account id. The first version matched gl.parent_id directly against
-- new.account_id, which selects no rows -- the cascade would have reported
-- success and silently orphaned every athlete it was written to protect.
create or replace function pilot.cascade_parent_deletion()
returns trigger as $fn$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update pilot.athletes a
       set deleted_at = new.deleted_at,
           updated_at = now()
     where a.organization_id = new.organization_id
       -- Never overwrite an earlier deletion timestamp: an athlete withdrawn
       -- before their guardian keeps their own, earlier, retention clock.
       and a.deleted_at is null
       and a.athlete_id in (
         select gl.athlete_id
           from pilot.guardian_links gl
           join pilot.parents p
             on p.organization_id = gl.organization_id
            and p.parent_id = gl.parent_id
          where gl.organization_id = new.organization_id
            and p.account_id = new.account_id
       );
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists pilot_cascade_parent_deletion_trigger on pilot.accounts;

create trigger pilot_cascade_parent_deletion_trigger
  after update on pilot.accounts
  for each row
  when (new.role = 'parent')
  execute function pilot.cascade_parent_deletion();

-- --- Audit event type: DATA_DELETION_INITIATED ---
-- The audit system already supports custom event_type values via the check
-- constraint, but we document that DATA_DELETION_INITIATED is a valid type.
-- If the constraint needs expansion, that's a separate admin migration.
-- For now, log to audit_events.details as jsonb.
