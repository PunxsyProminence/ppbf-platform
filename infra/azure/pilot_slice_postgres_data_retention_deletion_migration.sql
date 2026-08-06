-- Data retention and deletion infrastructure
--
-- Adds soft-delete (deleted_at) tracking to tables holding minor data,
-- and cascade-deletion logic so that deleting a guardian also marks
-- all linked athletes for deletion.
--
-- Idempotent and safe to re-apply.

do $$
begin
  -- ─── pilot.accounts: track guardian/parent deletion ───
  if not exists(
    select 1 from information_schema.columns
    where table_schema='pilot' and table_name='accounts' and column_name='deleted_at'
  ) then
    alter table pilot.accounts add column deleted_at timestamptz null;
  end if;

  -- ─── pilot.athletes: track athlete withdrawal ───
  if not exists(
    select 1 from information_schema.columns
    where table_schema='pilot' and table_name='athletes' and column_name='deleted_at'
  ) then
    alter table pilot.athletes add column deleted_at timestamptz null;
  end if;

  -- ─── pilot.coach_observations: already cascade-deletes with athlete ───
  -- (no change needed; constraint is already present)

  -- ─── Index: active athletes (deleted_at IS NULL) ───
  create index if not exists idx_athletes_active_org
    on pilot.athletes(organization_id, athlete_id)
    where deleted_at is null;

  -- ─── Index: active accounts (deleted_at IS NULL) ───
  create index if not exists idx_accounts_active_org
    on pilot.accounts(organization_id)
    where deleted_at is null;

  -- ─── Cascade deletion trigger: when a parent is deleted, mark their linked athletes ───
  --
  -- Why a trigger instead of a foreign key cascade: we want to SOFT-delete
  -- the athletes (mark deleted_at, not remove the row), so the cascade is
  -- "when accounts.deleted_at becomes NOT NULL, set athletes.deleted_at
  -- for all linked athletes". A FK cascade would DELETE the rows entirely,
  -- which happens too early (we want to keep them for retention period).

  create or replace function pilot.cascade_parent_deletion()
  returns trigger as $$
  begin
    if new.deleted_at is not null and old.deleted_at is null then
      -- Parent being deleted: mark all linked athletes for deletion too
      update pilot.athletes
        set deleted_at = new.deleted_at,
            updated_at = now()
        where organization_id = new.organization_id
          and athlete_id in (
            select athlete_id
              from pilot.guardian_links gl
              where gl.organization_id = new.organization_id
                and gl.parent_id = new.account_id
          );
    end if;
    return new;
  end;
  $$ language plpgsql;

  -- Drop the old trigger if it exists (idempotent)
  drop trigger if exists pilot_cascade_parent_deletion_trigger on pilot.accounts;

  -- Create the trigger only for parent/guardian accounts
  -- (role = 'parent' or 'organization_admin', not coaches/admins/platform_owner)
  create trigger pilot_cascade_parent_deletion_trigger
    after update on pilot.accounts
    for each row
    when (new.role = 'parent')
    execute function pilot.cascade_parent_deletion();

end $$;

-- ─── Audit event type: DATA_DELETION_INITIATED ───
-- The audit system already supports custom event_type values via the check
-- constraint, but we document that DATA_DELETION_INITIATED is a valid type.
-- If the constraint needs expansion, that's a separate admin migration.
-- For now, log to audit_events.details as jsonb.
