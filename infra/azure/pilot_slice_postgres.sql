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
  login_email text null,
  auth_provider text not null default 'ppbf_local' check (auth_provider in ('ppbf_local', 'microsoft')),
  role text not null check (role in ('platform_owner', 'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff')),
  organization_id text not null references pilot.organizations(organization_id),
  is_platform_owner boolean not null default false,
  athlete_id text null,
  pin_hash text null,
  active_flag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, athlete_id)
);

create unique index if not exists pilot_accounts_login_email_uq
  on pilot.accounts (lower(login_email))
  where login_email is not null;

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

create table if not exists pilot.shadow_library_sources (
  source_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  title text not null,
  publisher text null,
  source_type text not null,
  authority_tier smallint not null,
  url text null,
  publication_date date null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_by_account_id text null,
  created_by_role text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, url)
);

create table if not exists pilot.shadow_library_documents (
  document_id text primary key,
  source_id text not null references pilot.shadow_library_sources(source_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id),
  subject_id text null,
  document_name text not null,
  blob_path text null,
  content_sha256 text null,
  ingest_state text not null default 'pending',
  extraction_error text null,
  metadata jsonb not null default '{}'::jsonb,
  created_by_account_id text null,
  created_by_role text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, content_sha256)
);

create table if not exists pilot.shadow_library_capability_map (
  capability_map_id text primary key,
  organization_id text not null references pilot.organizations(organization_id),
  capability_key text not null,
  required_source_types text[] not null default '{}'::text[],
  minimum_authority_tier smallint not null default 3,
  minimum_source_count smallint not null default 1,
  coverage_state text not null default 'unknown',
  last_evaluated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, capability_key)
);

create table if not exists pilot.shadow_library_chunks (
  chunk_id text primary key,
  document_id text not null references pilot.shadow_library_documents(document_id) on delete cascade,
  source_id text not null references pilot.shadow_library_sources(source_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id),
  subject_id text null,
  ordinal int not null,
  text_content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by_account_id text null,
  created_by_role text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, ordinal)
);

create index if not exists idx_shadow_library_sources_org_created
  on pilot.shadow_library_sources(organization_id, created_at desc);

create index if not exists idx_shadow_library_documents_org_created
  on pilot.shadow_library_documents(organization_id, created_at desc);

create index if not exists idx_shadow_library_cap_map_org_updated
  on pilot.shadow_library_capability_map(organization_id, updated_at desc);

create index if not exists idx_shadow_library_chunks_org_created
  on pilot.shadow_library_chunks(organization_id, created_at desc);

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

-- SHADOW Feedback (effectiveness tracking)
create table if not exists pilot.shadow_feedback (
  feedback_id       bigserial primary key,
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  account_id        text not null,
  role              text not null,
  shadow_event_id   bigint null references pilot.shadow_events(shadow_event_id) on delete set null,
  recommendation_ref text null,
  helpful           boolean not null,
  rating            integer null check (rating between 1 and 5),
  comment           text null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_shadow_feedback_org_created
  on pilot.shadow_feedback(organization_id, created_at desc);

-- SHADOW User Profiles (personal shadow per member)
create table if not exists pilot.shadow_user_profiles (
  profile_id            bigserial primary key,
  account_id            text not null,
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  role                  text not null,
  interaction_count     integer not null default 0,
  last_interaction_at   timestamptz null,
  recent_topics         text[] not null default '{}',
  athlete_ids_discussed text[] not null default '{}',
  open_questions        text[] not null default '{}',
  remembered_facts      jsonb not null default '[]'::jsonb,
  communication_style   text not null default 'unknown' check (communication_style in ('concise', 'detailed', 'example-heavy', 'unknown')),
  shadow_notes          text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (account_id, organization_id)
);

create index if not exists idx_shadow_user_profiles_org
  on pilot.shadow_user_profiles(organization_id, role);

-- SHADOW Chat Audit (conversation event log)
create table if not exists pilot.shadow_chat_audit (
  chat_audit_id    bigserial primary key,
  organization_id  text not null references pilot.organizations(organization_id) on delete cascade,
  user_id          text not null,
  user_role        text not null,
  athlete_id       text null,
  user_message     text not null,
  shadow_response  text not null,
  was_filtered     boolean not null default false,
  created_at       timestamptz not null default now()
);

create index if not exists idx_shadow_chat_audit_org_created
  on pilot.shadow_chat_audit(organization_id, created_at desc);

create index if not exists idx_shadow_chat_audit_user_created
  on pilot.shadow_chat_audit(user_id, created_at desc);


-- SHADOW durable user-owned conversations
create table if not exists pilot.shadow_chat_sessions (
  conversation_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  user_id text not null,
  athlete_id text null,
  title text not null default 'New conversation',
  session_type text not null default 'quick_round',
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shadow_chat_sessions_owner
  on pilot.shadow_chat_sessions(organization_id, user_id, updated_at desc)
  where deleted_at is null;

create table if not exists pilot.shadow_chat_messages (
  message_id uuid primary key,
  conversation_id uuid not null references pilot.shadow_chat_sessions(conversation_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_chat_messages_conversation
  on pilot.shadow_chat_messages(organization_id, conversation_id, created_at asc);

-- Safety review is queued for humans; this table never sends notifications by itself.
create table if not exists pilot.shadow_human_review_queue (
  review_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  conversation_id uuid null references pilot.shadow_chat_sessions(conversation_id) on delete set null,
  user_id text not null,
  category text not null,
  severity text not null,
  summary text not null,
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  metadata jsonb not null default '{}'::jsonb,
  reviewed_by text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_human_review_org_status
  on pilot.shadow_human_review_queue(organization_id, status, created_at desc);

-- Deletion requests require authorized policy/legal review before execution.
create table if not exists pilot.shadow_data_deletion_requests (
  request_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  user_id text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'completed', 'denied')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz null,
  processed_by text null
);

create index if not exists idx_shadow_deletion_requests_org_status
  on pilot.shadow_data_deletion_requests(organization_id, status, requested_at desc);

-- SHADOW Progressive Unlocks (configuration-driven threshold engine)
create table if not exists pilot.shadow_feature_thresholds (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  feature_key           text not null,
  metric_key            text not null,
  min_value             integer not null check (min_value >= 0),
  activation_mode       text not null default 'enabled',
  description           text not null default '',
  created_by_account_id text null,
  updated_by_account_id text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, feature_key)
);

create table if not exists pilot.shadow_feature_unlock_snapshots (
  organization_id  text not null references pilot.organizations(organization_id) on delete cascade,
  account_id       text not null,
  feature_key      text not null,
  metric_key       text not null,
  unlocked         boolean not null,
  activation_mode  text not null,
  satisfied        boolean not null,
  current_value    integer not null default 0,
  threshold_value  integer not null default 0,
  details          jsonb not null default '{}'::jsonb,
  evaluated_at     timestamptz not null default now(),
  primary key (organization_id, account_id, feature_key)
);

create index if not exists idx_shadow_feature_thresholds_org
  on pilot.shadow_feature_thresholds(organization_id, feature_key);

create index if not exists idx_shadow_feature_unlock_snapshots_org_eval
  on pilot.shadow_feature_unlock_snapshots(organization_id, evaluated_at desc);

-- Scheduler: classes, registrations, coaching requests, attendance
create table if not exists pilot.scheduler_classes (
  organization_id            text not null references pilot.organizations(organization_id) on delete cascade,
  class_id                   text not null,
  title                      text not null,
  start_at                   timestamptz not null,
  end_at                     timestamptz not null,
  location                   text not null,
  capacity                   integer not null check (capacity > 0 and capacity <= 200),
  scheduled_by_account_id    text not null,
  coach_account_id           text not null,
  covering_coach_account_id  text null,
  status                     text not null check (status in ('open', 'full', 'cancelled')),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (organization_id, class_id)
);

create index if not exists idx_scheduler_classes_org_start
  on pilot.scheduler_classes(organization_id, start_at asc);

create table if not exists pilot.scheduler_registrations (
  organization_id             text not null references pilot.organizations(organization_id) on delete cascade,
  registration_id             text not null,
  class_id                    text not null,
  athlete_id                  text not null,
  requested_by_role           text not null check (requested_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
  requested_by_account_id     text not null,
  parent_reviewed             boolean not null default false,
  parent_reviewed_at          timestamptz null,
  parent_reviewer_account_id  text null,
  status                      text not null check (status in ('registered', 'waitlisted', 'cancelled')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  primary key (organization_id, registration_id),
  foreign key (organization_id, class_id)
    references pilot.scheduler_classes(organization_id, class_id)
    on delete cascade,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_scheduler_registrations_org_class
  on pilot.scheduler_registrations(organization_id, class_id, status);

create index if not exists idx_scheduler_registrations_org_athlete
  on pilot.scheduler_registrations(organization_id, athlete_id, created_at desc);

create table if not exists pilot.scheduler_coaching_requests (
  organization_id            text not null references pilot.organizations(organization_id) on delete cascade,
  request_id                 text not null,
  athlete_id                 text not null,
  requested_by_role          text not null check (requested_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
  requested_by_account_id    text not null,
  preferred_at               timestamptz not null,
  goals                      text not null,
  status                     text not null check (status in ('pending', 'approved', 'declined')),
  assigned_coach_account_id  text null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (organization_id, request_id),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_scheduler_coaching_requests_org_athlete
  on pilot.scheduler_coaching_requests(organization_id, athlete_id, created_at desc);

create table if not exists pilot.scheduler_attendance (
  organization_id         text not null references pilot.organizations(organization_id) on delete cascade,
  attendance_id           text not null,
  class_id                text not null,
  athlete_id              text not null,
  status                  text not null check (status in ('present', 'absent', 'excused')),
  method                  text not null check (method in ('self', 'coach_override', 'admin_override')),
  checked_in_by_role      text not null check (checked_in_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
  checked_in_by_account_id text not null,
  note                    text not null default '',
  checked_in_at           timestamptz not null,
  updated_at              timestamptz not null default now(),
  primary key (organization_id, attendance_id),
  unique (organization_id, class_id, athlete_id),
  foreign key (organization_id, class_id)
    references pilot.scheduler_classes(organization_id, class_id)
    on delete cascade,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_scheduler_attendance_org_class
  on pilot.scheduler_attendance(organization_id, class_id, checked_in_at desc);

-- Document ingest backend audit stream
create table if not exists pilot.document_ingest_audit (
  audit_id     bigserial primary key,
  occurred_at  timestamptz not null default now(),
  status       text not null check (status in ('success', 'failure')),
  file_name    text null,
  message      text null,
  details      jsonb not null default '{}'::jsonb
);

create index if not exists idx_document_ingest_audit_occurred_at
  on pilot.document_ingest_audit(occurred_at desc);

-- Admin capability registry (organization-scoped persisted configuration)
create table if not exists pilot.admin_capability_registry (
  organization_id        text primary key references pilot.organizations(organization_id) on delete cascade,
  capabilities           jsonb not null default '[]'::jsonb,
  updated_by_account_id  text not null,
  updated_at             timestamptz not null default now()
);

create table if not exists pilot.admin_track_assignments (
  organization_id        text primary key references pilot.organizations(organization_id) on delete cascade,
  assignments            jsonb not null default '{}'::jsonb,
  updated_by_account_id  text not null,
  updated_at             timestamptz not null default now()
);

create table if not exists pilot.admin_gym_capability_access (
  organization_id        text primary key references pilot.organizations(organization_id) on delete cascade,
  capability_access      jsonb not null default '{}'::jsonb,
  updated_by_account_id  text not null,
  updated_at             timestamptz not null default now()
);

-- Athlete floor plans generated during readiness check-in
create table if not exists pilot.athlete_floor_plans (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  plan_id                text not null,
  athlete_id             text not null,
  generated_at           timestamptz not null,
  readiness              text not null,
  athlete_name           text not null,
  payload                jsonb not null,
  created_by_account_id  text not null,
  created_by_role        text not null,
  created_at             timestamptz not null default now(),
  primary key (organization_id, plan_id),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_athlete_floor_plans_org_athlete_generated
  on pilot.athlete_floor_plans(organization_id, athlete_id, generated_at desc);

create index if not exists idx_admin_track_assignments_updated
  on pilot.admin_track_assignments(updated_at desc);

create index if not exists idx_admin_gym_capability_access_updated
  on pilot.admin_gym_capability_access(updated_at desc);
