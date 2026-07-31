-- Publication workflow tables (audit task: schema ownership). Third of three.
--
-- WHY THIS EXISTS
--
-- pilot.video_publications, pilot.publication_checks and
-- pilot.research_library were created ONLY by
-- /api/pilot/admin/migrate-multiorg -- a bootstrap-key HTTP route issuing 125
-- DDL statements. No migration file owned them, so `apply-migrations` could
-- never create them under ANY choice including `all`. Behind them sit
-- /coach/video-publications and /api/pilot/publications/{library,publish,create,check}.
--
-- With progression and compliance already migrated, this closes the last of
-- the nine live tables the schema-ownership audit found.
--
-- A NO-OP WHERE THE TABLES EXIST
--
-- The DDL is copied VERBATIM from the route rather than rewritten, and
-- everything is `if not exists`, so applying this over a live install changes
-- nothing and cannot drift from what that environment already carries. The
-- sibling compliance tables are PROVEN to exist in production, so these very
-- likely do too -- which makes a redefinition the dangerous outcome, not the
-- safe one. The goal is to make the migration path ABLE to produce this
-- schema, not to restate it.
--
-- DEPENDS ON video_sessions
--
-- Both video_publications and research_library carry `references
-- pilot.video_sessions(...)`, and video_sessions is NOT in the base schema --
-- it became migration-owned only in #125. Applying this against a database
-- without that table fails at the foreign key. The `all` loop already orders
-- video-sessions ahead of this one; dispatching `publications` alone against
-- a fresh environment requires `video-sessions` first.
--
-- ORDER MATTERS WITHIN THIS FILE
--
-- video_publications is created FIRST because publication_checks and
-- research_library both reference it. This mirrors the route's own ordering.

create schema if not exists pilot;

create table if not exists pilot.video_publications (
  publication_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  video_session_id text not null references pilot.video_sessions(video_session_id) on delete cascade,
  athlete_id text not null,
  submitted_by_account_id text not null references pilot.accounts(account_id),
  publication_type text not null check (publication_type in ('research_library', 'public_coaching', 'private_archive')),
  title text not null,
  description text not null,
  tags text[] not null default '{}'::text[],
  approved_by_account_id text null references pilot.accounts(account_id),
  compliance_check_status text not null default 'pending' check (compliance_check_status in ('pending', 'passed', 'failed', 'manual_review')),
  metadata_complete boolean not null default false,
  visibility text not null default 'private' check (visibility in ('private', 'organization', 'public', 'research')),
  published_at timestamptz null,
  archived_at timestamptz null,
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'approved', 'published', 'rejected', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_video_publications_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.publication_checks (
  check_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  publication_id text not null references pilot.video_publications(publication_id) on delete cascade,
  check_type text not null check (check_type in ('compliance', 'safety', 'metadata', 'consent', 'legal')),
  check_status text not null check (check_status in ('passed', 'failed', 'warning', 'manual_review')),
  details text not null,
  checked_by_account_id text null references pilot.accounts(account_id),
  checked_at timestamptz null,
  created_at timestamptz not null default now()
);

create table if not exists pilot.research_library (
  library_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  publication_id text not null references pilot.video_publications(publication_id) on delete cascade,
  video_session_id text not null references pilot.video_sessions(video_session_id),
  title text not null,
  description text not null,
  tags text[] not null default '{}'::text[],
  view_count integer not null default 0,
  citation_count integer not null default 0,
  last_accessed_at timestamptz null,
  published_at timestamptz not null default now(),
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Three indexes, matching the route exactly. It creates none on
-- publication_checks. The runner asserts these three rather than inventing
-- coverage the route never had.
create index if not exists idx_video_publications_status on pilot.video_publications(organization_id, status, created_at desc);
create index if not exists idx_research_library_published on pilot.research_library(organization_id, published_at desc);
create index if not exists idx_research_library_tags on pilot.research_library(organization_id, tags);

comment on table pilot.video_publications is
  'Athlete video submitted for publication review. Owned by pilot_slice_postgres_publications_migration.sql; also created by the legacy migrate-multiorg HTTP route, which must stay byte-compatible with this file.';
