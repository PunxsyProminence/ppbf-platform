-- PPBF Pilot Slice Schema (isolated, Azure PostgreSQL)
-- Applies approved backend slice for Athlete/Goal/Session/Coach Review/SHADOW Intake.

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

create table if not exists pilot.accounts (
  account_id text primary key,
  role text not null check (role in ('platform_owner', 'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff')),
  organization_id text not null references pilot.organizations(organization_id),
  is_platform_owner boolean not null default false,
  athlete_id text null,
  pin_hash text not null,
  active_flag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, athlete_id)
);

create table if not exists pilot.session_tokens (
  token_hash text primary key,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create table if not exists pilot.athletes (
  organization_id text not null references pilot.organizations(organization_id),
  athlete_id text not null,
  full_name text not null,
  dob date not null,
  weight_class text not null,
  gym_status text not null,
  emergency_contact text not null,
  active_flag boolean not null,
  coach_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pilot_athletes_pk primary key (organization_id, athlete_id),
  constraint pilot_athletes_coach_fk foreign key (coach_id) references pilot.accounts(account_id)
);

create table if not exists pilot.goals (
  organization_id text not null references pilot.organizations(organization_id),
  goal_id text not null,
  athlete_id text not null,
  title text not null,
  target_date date not null,
  metric text not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pilot_goals_pk primary key (organization_id, goal_id),
  constraint pilot_goals_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.sessions (
  organization_id text not null references pilot.organizations(organization_id),
  session_id text not null,
  athlete_id text not null,
  date date not null,
  rpe numeric not null,
  notes text not null,
  completed_flag boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pilot_sessions_pk primary key (organization_id, session_id),
  constraint pilot_sessions_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.coach_reviews (
  organization_id text not null references pilot.organizations(organization_id),
  review_id text not null,
  session_id text not null,
  coach_id text not null references pilot.accounts(account_id),
  decision text not null,
  notes text not null,
  approved_flag boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pilot_coach_reviews_pk primary key (organization_id, review_id),
  constraint pilot_coach_reviews_session_fk foreign key (organization_id, session_id) references pilot.sessions(organization_id, session_id) on delete cascade
);

create table if not exists pilot.shadow_intake (
  organization_id text not null references pilot.organizations(organization_id),
  intake_id uuid not null,
  file_name text not null,
  file_path text not null,
  classification text not null,
  routed_queue text not null,
  review_status text not null,
  uploaded_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_shadow_intake_pk primary key (organization_id, intake_id)
);

create table if not exists pilot.audit_events (
  audit_id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('create', 'update', 'login', 'logout', 'shadow_classification', 'shadow_routing')),
  actor_account_id text null,
  actor_role text null,
  organization_id text null references pilot.organizations(organization_id),
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pilot.shadow_authority_checks (
  authority_check_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id),
  actor_account_id text null,
  actor_role text null,
  action text not null,
  automation_mode text not null,
  confidence_tier text not null,
  allowed boolean not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pilot.shadow_events (
  shadow_event_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id),
  event_name text not null,
  entity_type text not null,
  entity_id text not null,
  actor_account_id text null,
  actor_role text null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pilot.shadow_telemetry_events (
  shadow_telemetry_event_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id),
  metric_name text not null,
  actor_account_id text null,
  actor_role text null,
  dimensions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
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

create table if not exists pilot.staff (
  organization_id text not null references pilot.organizations(organization_id),
  staff_id text not null,
  account_id text null references pilot.accounts(account_id),
  full_name text not null,
  title text not null,
  active_flag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, staff_id)
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

create table if not exists pilot.intake_cases (
  organization_id text not null references pilot.organizations(organization_id),
  intake_case_id uuid not null,
  status text not null check (status in ('pending_review', 'approved', 'rejected', 'promoted')),
  primary_athlete_id text null,
  source_shadow_intake_id uuid null,
  summary text not null,
  submitted_by_account_id text not null references pilot.accounts(account_id),
  reviewed_by_account_id text null references pilot.accounts(account_id),
  review_notes text null,
  promoted_at timestamptz null,
  rejected_at timestamptz null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_intake_cases_pk primary key (organization_id, intake_case_id)
);

create table if not exists pilot.intake_documents (
  organization_id text not null references pilot.organizations(organization_id),
  intake_document_id uuid not null,
  intake_case_id uuid not null,
  shadow_intake_id uuid null,
  document_type text not null check (document_type in ('athlete_registration', 'emergency_contact', 'medical_form', 'waiver_consent', 'assessment_document', 'general_intake')),
  file_name text not null,
  blob_path text not null,
  classification text not null,
  review_status text not null check (review_status in ('pending_review', 'approved', 'rejected', 'promoted')),
  owner_entity_type text null,
  owner_entity_id text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_intake_documents_pk primary key (organization_id, intake_document_id),
  constraint pilot_intake_documents_case_fk foreign key (organization_id, intake_case_id) references pilot.intake_cases(organization_id, intake_case_id) on delete cascade
);

create table if not exists pilot.emergency_contacts (
  organization_id text not null references pilot.organizations(organization_id),
  contact_id uuid not null,
  athlete_id text not null,
  full_name text not null,
  relationship_to_athlete text not null,
  phone text not null,
  email text null,
  is_primary boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_emergency_contacts_pk primary key (organization_id, contact_id),
  constraint pilot_emergency_contacts_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.medical_intake (
  organization_id text not null references pilot.organizations(organization_id),
  medical_id uuid not null,
  athlete_id text not null,
  conditions text not null default '',
  medications text not null default '',
  allergies text not null default '',
  physician_name text not null default '',
  physician_phone text not null default '',
  clearance_status text not null default 'pending',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_medical_intake_pk primary key (organization_id, medical_id),
  constraint pilot_medical_intake_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.waivers (
  organization_id text not null references pilot.organizations(organization_id),
  waiver_id uuid not null,
  athlete_id text not null,
  waiver_type text not null,
  signed_by_name text not null,
  signed_by_role text not null,
  signed_at timestamptz not null,
  consent_version text not null,
  status text not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_waivers_pk primary key (organization_id, waiver_id),
  constraint pilot_waivers_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.guardian_links (
  organization_id text not null references pilot.organizations(organization_id),
  parent_id text not null,
  athlete_id text not null,
  relationship_to_athlete text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_guardian_links_pk primary key (organization_id, parent_id, athlete_id),
  constraint pilot_guardian_links_parent_fk foreign key (organization_id, parent_id) references pilot.parents(organization_id, parent_id) on delete cascade,
  constraint pilot_guardian_links_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.coach_observations (
  organization_id text not null references pilot.organizations(organization_id),
  note_id uuid not null,
  athlete_id text not null,
  coach_account_id text not null references pilot.accounts(account_id),
  note_type text not null,
  note_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_coach_observations_pk primary key (organization_id, note_id),
  constraint pilot_coach_observations_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create table if not exists pilot.messages (
  organization_id text not null references pilot.organizations(organization_id),
  message_id uuid not null,
  sender_account_id text not null references pilot.accounts(account_id),
  recipient_account_id text not null references pilot.accounts(account_id),
  body text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, message_id)
);

create table if not exists pilot.skills (
  organization_id text not null references pilot.organizations(organization_id),
  skill_id uuid not null,
  athlete_id text not null,
  skill_name text not null,
  level text not null,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, skill_id),
  constraint pilot_skills_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_pilot_memberships_org_role on pilot.organization_memberships(organization_id, role);
create index if not exists idx_pilot_sessions_org_athlete_id on pilot.sessions(organization_id, athlete_id);
create index if not exists idx_pilot_goals_org_athlete_id on pilot.goals(organization_id, athlete_id);
create index if not exists idx_pilot_coach_reviews_org_session_id on pilot.coach_reviews(organization_id, session_id);
create index if not exists idx_pilot_audit_events_created_at on pilot.audit_events(created_at desc);
create index if not exists idx_pilot_audit_events_org_created_at on pilot.audit_events(organization_id, created_at desc);
create index if not exists idx_shadow_authority_checks_org_created on pilot.shadow_authority_checks(organization_id, created_at desc);
create index if not exists idx_shadow_events_org_created on pilot.shadow_events(organization_id, created_at desc);
create index if not exists idx_shadow_telemetry_org_created on pilot.shadow_telemetry_events(organization_id, created_at desc);
create index if not exists idx_pilot_shadow_org_review_status on pilot.shadow_intake(organization_id, review_status);
create index if not exists idx_pilot_attendance_org_athlete_date on pilot.attendance(organization_id, athlete_id, attendance_date desc);
create index if not exists idx_pilot_readiness_org_athlete_measured on pilot.readiness(organization_id, athlete_id, measured_at desc);
create index if not exists idx_pilot_assessments_org_athlete_created on pilot.assessments(organization_id, athlete_id, created_at desc);
create index if not exists idx_pilot_documents_org_owner on pilot.documents(organization_id, owner_entity_type, owner_entity_id);
create index if not exists idx_pilot_intake_cases_org_status on pilot.intake_cases(organization_id, status, updated_at desc);
create index if not exists idx_pilot_intake_documents_org_case on pilot.intake_documents(organization_id, intake_case_id, created_at desc);
create index if not exists idx_pilot_emergency_contacts_org_athlete on pilot.emergency_contacts(organization_id, athlete_id, created_at desc);
create index if not exists idx_pilot_medical_intake_org_athlete on pilot.medical_intake(organization_id, athlete_id, created_at desc);
create index if not exists idx_pilot_waivers_org_athlete on pilot.waivers(organization_id, athlete_id, created_at desc);
create index if not exists idx_pilot_guardian_links_org_athlete on pilot.guardian_links(organization_id, athlete_id);
create index if not exists idx_pilot_coach_observations_org_athlete on pilot.coach_observations(organization_id, athlete_id, created_at desc);
create index if not exists idx_pilot_messages_org_recipient_created on pilot.messages(organization_id, recipient_account_id, created_at desc);
create index if not exists idx_pilot_skills_org_athlete_recorded on pilot.skills(organization_id, athlete_id, recorded_at desc);
