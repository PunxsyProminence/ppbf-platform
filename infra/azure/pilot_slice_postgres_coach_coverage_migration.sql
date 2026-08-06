-- Migration: Add pilot.coach_coverage table for temporary covering coach access
--
-- Why this exists: A covering/substitute coach temporarily assigned to an athlete
-- was getting "Forbidden: coach not assigned to athlete" on every athlete-scoped route.
--
-- Shape: (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
-- Every read/write is scoped by organization_id.
--
-- Referential integrity: pilot.athletes is keyed on the COMPOSITE
-- (organization_id, athlete_id), so the athlete reference is a composite FK --
-- the same shape pilot_goals_athlete_fk, pilot_sessions_athlete_fk, and
-- pilot_attendance_athlete_fk already use. This is what makes the
-- organization_id column trustworthy rather than merely present: without it a
-- row could name org A while pointing at org B's athlete, and every scoped
-- read would still look correct.
--
-- The cascades matter for a table whose whole purpose is granting access:
-- when an athlete is offboarded or an account is deleted, coverage granting
-- someone access to them must not outlive them as an orphan row.

create table if not exists pilot.coach_coverage (
  coverage_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  covering_coach_id text not null references pilot.accounts(account_id) on delete cascade,
  granted_by_account_id text not null references pilot.accounts(account_id) on delete cascade,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint pilot_coach_coverage_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- A grant that expires at or before it starts is never active, so it can
  -- only be a mistake. Refusing it here means the application cannot write one
  -- even if a future caller skips resolveCoverageTtlHours.
  constraint pilot_coach_coverage_window_check check (expires_at > starts_at)
);

-- Idempotent backfill for the case where an earlier revision of this migration
-- created the table without its constraints. Additive and safe to re-run; it
-- adds nothing on a database where the create above already applied them.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.coach_coverage'::regclass
      and conname = 'pilot_coach_coverage_athlete_fk'
  ) then
    alter table pilot.coach_coverage
      add constraint pilot_coach_coverage_athlete_fk
      foreign key (organization_id, athlete_id)
      references pilot.athletes(organization_id, athlete_id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.coach_coverage'::regclass
      and conname = 'pilot_coach_coverage_window_check'
  ) then
    alter table pilot.coach_coverage
      add constraint pilot_coach_coverage_window_check
      check (expires_at > starts_at);
  end if;
end $$;

create index if not exists idx_pilot_coach_coverage_lookup
  on pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, expires_at);
