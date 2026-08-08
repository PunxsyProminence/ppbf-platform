-- PPBF Pilot Slice Multi-Organization Migration
-- Safe, additive migration for existing pilot schema installations.

create schema if not exists pilot;

create table if not exists pilot.organizations (
  organization_id text primary key,
  organization_name text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended', 'pending')),
  created_by_account_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pilot.organization_memberships (
  account_id text not null,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  role text not null check (role in ('platform_owner', 'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff')),
  active_flag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, organization_id)
);

create table if not exists pilot.parents (
  organization_id text not null references pilot.organizations(organization_id),
  parent_id text not null,
  account_id text null references pilot.accounts(account_id),
  full_name text not null,
  phone text null,
  email text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, parent_id)
);

create table if not exists pilot.volunteers (
  organization_id text not null references pilot.organizations(organization_id),
  volunteer_id text not null,
  account_id text null references pilot.accounts(account_id),
  full_name text not null,
  role text not null,
  active_flag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, volunteer_id)
);

create table if not exists pilot.attendance (
  organization_id text not null references pilot.organizations(organization_id),
  attendance_id uuid not null,
  athlete_id text not null,
  attendance_date date not null,
  status text not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, attendance_id),
  constraint pilot_attendance_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.readiness (
  organization_id text not null references pilot.organizations(organization_id),
  readiness_id uuid not null,
  athlete_id text not null,
  score numeric not null,
  category text not null,
  measured_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, readiness_id),
  constraint pilot_readiness_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.assessments (
  organization_id text not null references pilot.organizations(organization_id),
  assessment_id uuid not null,
  athlete_id text not null,
  assessor_account_id text null references pilot.accounts(account_id),
  assessment_type text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, assessment_id),
  constraint pilot_assessments_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.documents (
  organization_id text not null references pilot.organizations(organization_id),
  document_id uuid not null,
  owner_entity_type text not null,
  owner_entity_id text not null,
  storage_path text not null,
  classification text not null,
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, document_id)
);

-- 1) Add organization columns to existing tables.
alter table pilot.accounts add column if not exists organization_id text;
alter table pilot.accounts add column if not exists is_platform_owner boolean not null default false;
alter table pilot.accounts add column if not exists login_email text;
alter table pilot.accounts add column if not exists auth_provider text not null default 'ppbf_local';
alter table pilot.accounts add column if not exists has_master_shadow_access boolean not null default false;
alter table pilot.accounts alter column pin_hash drop not null;
alter table pilot.accounts drop constraint if exists pilot_accounts_auth_provider_check;
alter table pilot.accounts add constraint pilot_accounts_auth_provider_check
  check (auth_provider in ('ppbf_local', 'microsoft', 'magic_link'));

create unique index if not exists pilot_accounts_login_email_uq
  on pilot.accounts (lower(login_email))
  where login_email is not null;

alter table pilot.session_tokens add column if not exists organization_id text;
alter table pilot.athletes add column if not exists organization_id text;
alter table pilot.goals add column if not exists organization_id text;
alter table pilot.sessions add column if not exists organization_id text;
alter table pilot.coach_reviews add column if not exists organization_id text;
alter table pilot.shadow_intake add column if not exists organization_id text;
alter table pilot.audit_events add column if not exists organization_id text;

-- 2) Seed bootstrap organization.
insert into pilot.organizations (organization_id, organization_name, status)
values ('ppbf-default-org', 'PPBF Default Organization', 'active')
on conflict (organization_id) do nothing;

-- 3) Backfill organization ownership with bootstrap organization.
update pilot.accounts set organization_id = 'ppbf-default-org' where organization_id is null;
update pilot.session_tokens st
set organization_id = a.organization_id
from pilot.accounts a
where st.account_id = a.account_id and st.organization_id is null;

update pilot.athletes set organization_id = 'ppbf-default-org' where organization_id is null;
update pilot.goals set organization_id = 'ppbf-default-org' where organization_id is null;
update pilot.sessions set organization_id = 'ppbf-default-org' where organization_id is null;
update pilot.coach_reviews set organization_id = 'ppbf-default-org' where organization_id is null;
update pilot.shadow_intake set organization_id = 'ppbf-default-org' where organization_id is null;
update pilot.audit_events set organization_id = 'ppbf-default-org' where organization_id is null;

-- 4) Ensure bootstrap memberships for existing accounts.
insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
select account_id, organization_id, role, true from pilot.accounts
on conflict (account_id, organization_id) do update
set role = excluded.role,
    active_flag = true,
    updated_at = now();

-- 5) Set NOT NULL and FK constraints after backfill.
alter table pilot.accounts alter column organization_id set not null;
alter table pilot.session_tokens alter column organization_id set not null;
alter table pilot.athletes alter column organization_id set not null;
alter table pilot.goals alter column organization_id set not null;
alter table pilot.sessions alter column organization_id set not null;
alter table pilot.coach_reviews alter column organization_id set not null;
alter table pilot.shadow_intake alter column organization_id set not null;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, and because this file is
-- applied as a single multi-statement query, the server parses the whole file
-- before executing any of it -- so the previous form did not just fail these
-- eight statements, it made the entire migration unrunnable. Guard each FK
-- with a catalog check instead, in the same DO-block style used further down.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('pilot.accounts',        'pilot_accounts_org_fk'),
      ('pilot.session_tokens',  'pilot_session_tokens_org_fk'),
      ('pilot.athletes',        'pilot_athletes_org_fk'),
      ('pilot.goals',           'pilot_goals_org_fk'),
      ('pilot.sessions',        'pilot_sessions_org_fk'),
      ('pilot.coach_reviews',   'pilot_coach_reviews_org_fk'),
      ('pilot.shadow_intake',   'pilot_shadow_intake_org_fk'),
      ('pilot.audit_events',    'pilot_audit_events_org_fk')
    ) as t(tbl, con)
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = spec.con and conrelid = spec.tbl::regclass
    ) then
      execute format(
        'alter table %s add constraint %I foreign key (organization_id) references pilot.organizations(organization_id)',
        spec.tbl, spec.con
      );
    end if;
  end loop;
end $$;

-- 6) Add organization-scoped uniqueness where required.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'accounts_athlete_id_key' and conrelid = 'pilot.accounts'::regclass
  ) then
    alter table pilot.accounts drop constraint accounts_athlete_id_key;
  end if;
exception when others then
  null;
end $$;

create unique index if not exists uq_pilot_accounts_org_athlete on pilot.accounts(organization_id, athlete_id) where athlete_id is not null;
create unique index if not exists uq_pilot_accounts_org_account on pilot.accounts(organization_id, account_id);

-- 7) Add organization access indexes.
create index if not exists idx_pilot_memberships_org_role on pilot.organization_memberships(organization_id, role);
create index if not exists idx_pilot_sessions_org_athlete_id on pilot.sessions(organization_id, athlete_id);
create index if not exists idx_pilot_goals_org_athlete_id on pilot.goals(organization_id, athlete_id);
create index if not exists idx_pilot_coach_reviews_org_session_id on pilot.coach_reviews(organization_id, session_id);
create index if not exists idx_pilot_audit_events_org_created_at on pilot.audit_events(organization_id, created_at desc);
create index if not exists idx_pilot_shadow_org_review_status on pilot.shadow_intake(organization_id, review_status);
create index if not exists idx_pilot_attendance_org_athlete_date on pilot.attendance(organization_id, athlete_id, attendance_date desc);
create index if not exists idx_pilot_readiness_org_athlete_measured on pilot.readiness(organization_id, athlete_id, measured_at desc);
create index if not exists idx_pilot_assessments_org_athlete_created on pilot.assessments(organization_id, athlete_id, created_at desc);
create index if not exists idx_pilot_documents_org_owner on pilot.documents(organization_id, owner_entity_type, owner_entity_id);
