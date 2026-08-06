-- Migration: Add pilot.coach_coverage table for temporary covering coach access
--
-- Why this exists: A covering/substitute coach temporarily assigned to an athlete
-- was getting "Forbidden: coach not assigned to athlete" on every athlete-scoped route.
--
-- Shape: (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
-- Every read/write is scoped by organization_id.

create table if not exists pilot.coach_coverage (
  coverage_id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  athlete_id text not null,
  covering_coach_id text not null,
  granted_by_account_id text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pilot_coach_coverage_lookup
  on pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, expires_at);
