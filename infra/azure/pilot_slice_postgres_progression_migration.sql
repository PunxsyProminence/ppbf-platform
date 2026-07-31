-- Progression intelligence tables (audit task: schema ownership).
--
-- WHY THIS EXISTS
--
-- pilot.progression_gaps, pilot.drill_assignments and
-- pilot.assignment_completions were created ONLY by
-- /api/pilot/admin/migrate-multiorg -- a 938-line HTTP route, bootstrap-key
-- protected, that issues 125 DDL statements. No migration file owned them, so
-- `apply-migrations` could never create them under ANY choice, including
-- `all`: pilot_slice_postgres_multiorg_migration.sql creates organizations,
-- organization_memberships, parents, staff, volunteers, skills, assessments,
-- attendance, readiness, documents and messages -- and none of these three.
--
-- They exist today only where somebody ran that route by hand. Stand up a new
-- environment, or rebuild from migrations after a loss, and
-- /coach/progression-intelligence and /athlete/progression-intelligence fail
-- at the database. That is exactly how pilot.video_sessions stayed broken
-- until #125 -- every video upload had been failing at the CHECK constraint
-- and nobody noticed, because the schema's completeness depended on deploy
-- history rather than on anything a migration asserted.
--
-- THIS IS DELIBERATELY A NO-OP WHERE THE TABLES ALREADY EXIST
--
-- The DDL below is copied VERBATIM from the route, not rewritten. Everything
-- is `if not exists`, so applying this against a database that already has
-- these tables changes nothing -- it does not redefine them, and it cannot
-- drift from what a live environment already carries. The point is to make
-- the migration path able to produce the schema, not to restate it.
--
-- No catalog-guarded DO block is needed here, unlike the video_sessions
-- migration: that one had to REPLACE a stale CHECK constraint. This one adds
-- nothing to an existing table, and `create table if not exists` leaves a
-- present table entirely alone -- including its constraints.

create schema if not exists pilot;

create table if not exists pilot.progression_gaps (
  gap_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  athlete_id text not null,
  coach_account_id text not null references pilot.accounts(account_id),
  gap_type text not null check (gap_type in ('technique', 'strength', 'endurance', 'skill', 'mental', 'tactical')),
  gap_description text not null,
  severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low')),
  detected_from text not null,
  detected_from_id text null,
  detection_data jsonb not null default '{}'::jsonb,
  status text not null default 'identified' check (status in ('identified', 'assigned', 'in_progress', 'completed', 'deferred')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_progression_gaps_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.drill_assignments (
  assignment_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  gap_id text not null references pilot.progression_gaps(gap_id) on delete cascade,
  athlete_id text not null,
  assigned_by_account_id text not null references pilot.accounts(account_id),
  drill_name text not null,
  drill_description text not null,
  drill_difficulty text not null default 'intermediate' check (drill_difficulty in ('beginner', 'intermediate', 'advanced', 'elite')),
  rep_count integer null,
  duration_minutes integer null,
  frequency_per_week integer null,
  assigned_at timestamptz not null default now(),
  due_date date null,
  status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed', 'incomplete', 'cancelled')),
  completion_percentage integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_drill_assignments_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.assignment_completions (
  completion_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  assignment_id text not null references pilot.drill_assignments(assignment_id) on delete cascade,
  athlete_id text not null,
  completed_at timestamptz not null,
  reps_completed integer null,
  notes text not null default '',
  verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'disputed')),
  verified_by_account_id text null references pilot.accounts(account_id),
  verified_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_assignment_completions_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

-- The route creates these alongside the tables. An environment that got the
-- tables from the route but not the indexes would still serve the pages, just
-- unindexed -- so the runner asserts all three indexes, not only the tables.
create index if not exists idx_progression_gaps_athlete on pilot.progression_gaps(organization_id, athlete_id, created_at desc);
create index if not exists idx_drill_assignments_status on pilot.drill_assignments(organization_id, status, due_date);
create index if not exists idx_assignment_completions_assignment on pilot.assignment_completions(organization_id, assignment_id);

comment on table pilot.progression_gaps is
  'Coach-identified athlete development gaps. Owned by pilot_slice_postgres_progression_migration.sql; also created by the legacy migrate-multiorg HTTP route, which must stay byte-compatible with this file.';
