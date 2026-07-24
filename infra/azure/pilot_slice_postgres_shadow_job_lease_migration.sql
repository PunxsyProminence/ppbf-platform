-- Additive SHADOW job-lease hardening.
-- Apply after pilot_slice_postgres_shadow_runtime_migration.sql.
begin;

alter table pilot.shadow_jobs
  add column if not exists lease_token uuid null,
  add column if not exists lease_expires_at timestamptz null;

create unique index if not exists idx_shadow_jobs_lease_token
  on pilot.shadow_jobs(lease_token)
  where lease_token is not null;

create index if not exists idx_shadow_jobs_running_lease
  on pilot.shadow_jobs(lease_expires_at asc)
  where status = 'running';

do $shadow_job_lease_constraints$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_lease_pair_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_lease_pair_check
      check (
        (lease_token is null and lease_expires_at is null)
        or
        (lease_token is not null and lease_expires_at is not null)
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.shadow_jobs'::regclass
      and conname = 'shadow_jobs_non_running_lease_check'
  ) then
    alter table pilot.shadow_jobs
      add constraint shadow_jobs_non_running_lease_check
      check (
        status = 'running'
        or
        (lease_token is null and lease_expires_at is null)
      );
  end if;
end
$shadow_job_lease_constraints$;

commit;
