-- PPBF Merged Supabase Schema v2.0 (Expanded)
create extension if not exists "uuid-ossp";

create table if not exists profiles (
  id uuid primary key references auth.users,
  role text check (role in ('athlete','guardian','coach','admin')),
  full_name text
);

create table if not exists participants (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid references profiles(id),
  age_band text,
  classification text,
  adaptation_notes jsonb,
  baseline jsonb,
  risk_flags jsonb
);

create table if not exists sessions (
  id uuid primary key default uuid_generate_v4(),
  participant_id uuid references participants(id),
  date date,
  intensity int,
  reflections text,
  safety_flags jsonb,
  quality_score jsonb
);

create table if not exists coach_reviews (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid references sessions(id),
  decision text,
  notes text,
  jason_approval boolean default false
);

create table if not exists safety_gates (
  id uuid primary key default uuid_generate_v4(),
  participant_id uuid references participants(id),
  red_flags jsonb,
  escalation_level text,
  resolved boolean default false
);

create table if not exists athlete_voice (
  id uuid primary key default uuid_generate_v4(),
  participant_id uuid references participants(id),
  how_hard int,
  confusing text,
  confidence int,
  motivation int
);

create table if not exists physical_training_logs (
  id uuid primary key default uuid_generate_v4(),
  participant_id uuid references participants(id),
  engine text,
  metrics jsonb
);

create table if not exists continuity_ledger (
  id uuid primary key default uuid_generate_v4(),
  event_type text,
  capability_id int,
  details jsonb,
  approved_by text
);
