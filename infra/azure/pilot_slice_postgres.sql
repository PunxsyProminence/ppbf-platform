-- PPBF Pilot Slice Schema (isolated, Azure PostgreSQL)
-- Applies approved backend slice for Athlete/Goal/Session/Coach Review/SHADOW Intake.

create schema if not exists pilot;

create table if not exists pilot.accounts (
  account_id text primary key,
  role text not null check (role in ('admin', 'coach', 'athlete')),
  athlete_id text null,
  pin_hash text not null,
  active_flag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_id)
);

create table if not exists pilot.session_tokens (
  token_hash text primary key,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create table if not exists pilot.athletes (
  athlete_id text primary key,
  full_name text not null,
  dob date not null,
  weight_class text not null,
  gym_status text not null,
  emergency_contact text not null,
  active_flag boolean not null,
  coach_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pilot_athletes_coach_fk foreign key (coach_id) references pilot.accounts(account_id)
);

create table if not exists pilot.goals (
  goal_id text primary key,
  athlete_id text not null references pilot.athletes(athlete_id) on delete cascade,
  title text not null,
  target_date date not null,
  metric text not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists pilot.sessions (
  session_id text primary key,
  athlete_id text not null references pilot.athletes(athlete_id) on delete cascade,
  date date not null,
  rpe numeric not null,
  notes text not null,
  completed_flag boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists pilot.coach_reviews (
  review_id text primary key,
  session_id text not null references pilot.sessions(session_id) on delete cascade,
  coach_id text not null references pilot.accounts(account_id),
  decision text not null,
  notes text not null,
  approved_flag boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists pilot.shadow_intake (
  intake_id uuid primary key,
  file_name text not null,
  file_path text not null,
  classification text not null,
  routed_queue text not null,
  review_status text not null,
  uploaded_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pilot.audit_events (
  audit_id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('create', 'update', 'login', 'logout', 'shadow_classification', 'shadow_routing')),
  actor_account_id text null,
  actor_role text null,
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_pilot_sessions_athlete_id on pilot.sessions(athlete_id);
create index if not exists idx_pilot_goals_athlete_id on pilot.goals(athlete_id);
create index if not exists idx_pilot_coach_reviews_session_id on pilot.coach_reviews(session_id);
create index if not exists idx_pilot_audit_events_created_at on pilot.audit_events(created_at desc);
create index if not exists idx_pilot_shadow_review_status on pilot.shadow_intake(review_status);
