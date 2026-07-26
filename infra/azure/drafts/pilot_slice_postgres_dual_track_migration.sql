-- ============================================================================
-- DRAFT MIGRATION -- NOT APPLIED, NOT WIRED TO ANY apply-script.
--
-- This file lives under infra/azure/drafts/ specifically so it is not picked
-- up by the existing pilot:apply-* npm scripts (each of which references an
-- exact filename under infra/azure/). It must not be run against staging or
-- production, and this package does not run it anywhere -- it exists only
-- to make the "reusable dual-track athlete configuration schema" concrete
-- as a real additive migration, for review before any future authorized
-- apply step.
--
-- Prerequisite: pilot_slice_postgres.sql and
-- pilot_slice_postgres_multiorg_migration.sql must already be applied
-- (pilot.organizations, pilot.athletes).
-- ============================================================================
begin;

create table if not exists pilot.athlete_dual_track_programs (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  program_id text not null,
  primary_track_key text not null,
  primary_track_display_name text not null,
  secondary_track_key text not null,
  secondary_track_display_name text not null,
  -- Structural invariant: total workload authority always sits with the
  -- primary track. This column exists so the invariant is enforced by the
  -- database, not only by application code (see schema.ts
  -- validateDualTrackProgram for the equivalent application-layer check).
  workload_authority_track_role text not null default 'primary'
    check (workload_authority_track_role = 'primary'),
  mandatory_gates text[] not null,
  never_replaces_domains text[] not null,
  has_restricted_administrative_lane boolean not null default false,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'archived')),
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_athlete_dual_track_programs_pk primary key (organization_id, program_id),
  constraint pilot_athlete_dual_track_programs_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  -- All four mandatory gate categories must be present -- mirrors
  -- REQUIRED_MANDATORY_GATE_CATEGORIES in schema.ts.
  constraint pilot_athlete_dual_track_programs_gates_check check (
    mandatory_gates @> array['recovery', 'safety', 'water_safety', 'workload_management']::text[]
  ),
  -- The secondary track must declare it never replaces every core
  -- conditioning domain -- mirrors CORE_CONDITIONING_DOMAINS in schema.ts.
  constraint pilot_athlete_dual_track_programs_never_replaces_check check (
    never_replaces_domains @> array['running', 'swimming', 'rucking', 'calisthenics', 'water_confidence', 'recovery']::text[]
  )
);

create unique index if not exists idx_athlete_dual_track_programs_one_active_per_athlete
  on pilot.athlete_dual_track_programs(organization_id, athlete_id)
  where status = 'active';

create index if not exists idx_athlete_dual_track_programs_org_athlete
  on pilot.athlete_dual_track_programs(organization_id, athlete_id, updated_at desc);

-- Deliberately NOT included in this draft: any table for admin_restricted
-- content (recruiter/waiver/financial/government-identifier material). No
-- such table is proposed here because no access-tier-gated read path exists
-- yet to keep it out of ordinary coach/SHADOW-chat reach -- see
-- ACCESS_CONTROL_MATRIX.md and MAPPING.md. Adding a table without that read
-- path first would recreate the exact gap this package was scoped to avoid.

commit;
