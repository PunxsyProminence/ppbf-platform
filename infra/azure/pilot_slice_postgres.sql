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
  auth_provider text not null default 'ppbf_local' check (auth_provider in ('ppbf_local', 'microsoft', 'magic_link')),
  role text not null check (role in ('platform_owner', 'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff')),
  organization_id text not null references pilot.organizations(organization_id),
  is_platform_owner boolean not null default false,
  athlete_id text null,
  pin_hash text null,
  -- True while the account still holds the admin-issued bootstrap PIN.
  -- requirePrincipal refuses every route except the PIN change while this is
  -- set, so the starting PIN can never be used to read athlete data.
  must_change_pin boolean not null default false,
  active_flag boolean not null default true,
  has_master_shadow_access boolean not null default false,
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
  revoked_at timestamptz null,
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index if not exists idx_pilot_session_tokens_expires_at on pilot.session_tokens(expires_at);
create index if not exists idx_pilot_session_tokens_account_id on pilot.session_tokens(account_id);

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
  -- Canonical audit event vocabulary. The authoritative list lives in
  -- apps/web/src/server/pilot/auditEventTypes.ts, and
  -- auditEventVocabulary.test.ts asserts this constraint matches it -- these
  -- two previously drifted, and the missing value failed every SHADOW
  -- research-requirement upload at the audit write.
  event_type text not null check (event_type in ('create', 'update', 'login', 'logout', 'shadow_classification', 'shadow_routing', 'shadow_research_upload_requirement', 'safety_hold_placed', 'safety_hold_lifted', 'consent_granted', 'consent_withdrawn', 'data_deletion_initiated', 'data_purged')),
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
  outcome_signal    text null,
  correlation_type  text null,
  correlation_id    text null,
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'durable_client', 'human_reviewed')),
  human_review_required boolean not null default true,
  reviewed_by_account_id text null references pilot.accounts(account_id) on delete set null,
  reviewed_at       timestamptz null,
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
  method                  text not null check (method in ('self', 'parent', 'coach_override', 'admin_override')),
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

-- Safety Gate Matrix: reusable substrate for athlete-safety gates
-- (capabilities #3/#43). See
-- pilot_slice_postgres_safety_gate_matrix_migration.sql for the full
-- design rationale -- enforcement is 'block' or 'flag' per gate, never
-- assumed, and requirement_text carries the "teaching moment" lesson a
-- refusal or flag surfaces alongside the stop.
create table if not exists pilot.safety_gates (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  gate_id           text not null,
  gate_key          text not null,
  name              text not null,
  category          text not null check (category in ('medical', 'age', 'training_level', 'contact', 'equipment', 'behavioral', 'other')),
  enforcement       text not null check (enforcement in ('block', 'flag')),
  requirement_text  text not null,
  active_flag       boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (organization_id, gate_id),
  unique (organization_id, gate_key)
);

create table if not exists pilot.safety_gate_evaluations (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  evaluation_id             text not null,
  gate_key                  text not null,
  athlete_id                text not null,
  outcome                   text not null check (outcome in ('passed', 'blocked', 'flagged')),
  reason                    text not null default '',
  evaluated_by_account_id   text not null,
  evaluated_by_role         text not null,
  context_id                text not null default '',
  metadata                  jsonb not null default '{}'::jsonb,
  evaluated_at              timestamptz not null,
  created_at                timestamptz not null default now(),
  primary key (organization_id, evaluation_id),
  foreign key (organization_id, gate_key)
    references pilot.safety_gates(organization_id, gate_key)
    on delete cascade,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_safety_gate_evaluations_org_athlete
  on pilot.safety_gate_evaluations(organization_id, athlete_id, evaluated_at desc);

create index if not exists idx_safety_gate_evaluations_org_gate
  on pilot.safety_gate_evaluations(organization_id, gate_key, evaluated_at desc);

-- Red Flag Escalation ladder (capability #194): pull-based surface a coach
-- or admin checks so a near miss, pain report, or safety-gate flag does not
-- sit undiscovered in its own insert-only table. See
-- pilot_slice_postgres_safety_escalations_migration.sql for the full design
-- rationale -- escalated_to_role is constrained and deliberately excludes
-- 'board' (an aggregate-only side channel, not a rung on the escalation
-- ladder).
create table if not exists pilot.safety_escalations (
  organization_id             text not null references pilot.organizations(organization_id) on delete cascade,
  escalation_id                text not null,
  source_type                  text not null check (source_type in ('near_miss', 'pain_report', 'safety_gate_evaluation', 'repeated_pattern', 'athlete_voice', 'training_hold', 'incident')),
  source_id                    text null,
  athlete_id                   text not null,
  severity                     text not null check (severity in ('low', 'moderate', 'high', 'critical')),
  reason                       text not null,
  escalated_to_role            text not null check (escalated_to_role in ('coach', 'organization_admin', 'admin')),
  triggered_by                 text not null check (triggered_by in ('system', 'human')),
  triggered_by_account_id      text null,
  triggered_by_role            text null,
  status                       text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by_account_id   text null,
  acknowledged_at              timestamptz null,
  resolved_by_account_id       text null,
  resolved_at                  timestamptz null,
  resolution_note              text not null default '',
  metadata                     jsonb not null default '{}'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  primary key (organization_id, escalation_id),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_safety_escalations_org_status
  on pilot.safety_escalations(organization_id, status, created_at desc);

create index if not exists idx_safety_escalations_org_athlete
  on pilot.safety_escalations(organization_id, athlete_id, created_at desc);

-- Coach coverage grants (ticket T-002): per-athlete, time-bounded access
-- for a coach substituting for the athlete's coach of record. See
-- pilot_slice_postgres_coach_coverage_migration.sql for the design
-- rationale (and why a roster-wide membership flag was rejected). The
-- access gate checks `starts_at <= now() and expires_at > now()` at read
-- time -- expiry needs no cron, and revocation forces expires_at to now().
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
  constraint pilot_coach_coverage_window_check check (expires_at > starts_at)
);

create index if not exists idx_pilot_coach_coverage_lookup
  on pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, expires_at);

-- Training holds (capability #82): durable, attributed, expiring pauses on
-- an athlete's training. See pilot_slice_postgres_training_holds_migration.sql
-- for the full design rationale (why not gym_status, why not a gate row
-- alone, what Stop/Hold/Regress each mean). The athlete_explanation is NOT
-- NULL on purpose: a hold a child cannot read a reason for is a punishment,
-- not a safety measure.
create table if not exists pilot.training_holds (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  hold_id                text not null,
  athlete_id             text not null,
  scope                  text not null check (scope in ('all_training', 'contact_only', 'conditioning_only')),
  reason_category        text not null check (reason_category in ('medical', 'fatigue', 'behavioral', 'administrative', 'other')),
  reason_text            text not null default '',
  athlete_explanation    text not null check (length(btrim(athlete_explanation)) > 0),
  lift_condition_text    text not null default '',
  placed_by_account_id   text not null,
  placed_by_role         text not null check (placed_by_role in ('coach', 'organization_admin', 'admin')),
  placed_at              timestamptz not null default now(),
  expires_at             timestamptz null,
  lifted_by_account_id   text null,
  lifted_at              timestamptz null,
  lift_note              text not null default '',
  status                 text not null default 'active' check (status in ('active', 'lifted', 'expired')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, hold_id),
  constraint pilot_training_holds_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint pilot_training_holds_expiry_check
    check (expires_at is null or expires_at > placed_at)
);

create unique index if not exists idx_training_holds_one_active
  on pilot.training_holds(organization_id, athlete_id)
  where status = 'active';

create index if not exists idx_training_holds_org_status
  on pilot.training_holds(organization_id, status, placed_at desc);

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

-- SHADOW durable conversations, privacy workflows, jobs, learning, and formulas.
-- These are deployment-time tables. Application request handlers must never
-- create or alter schema at runtime.
create table if not exists pilot.shadow_chat_sessions (
  conversation_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  athlete_id text null,
  title text not null default 'New conversation',
  session_type text not null default 'quick_round',
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_shadow_chat_sessions_owner
  on pilot.shadow_chat_sessions(organization_id, account_id, updated_at desc)
  where deleted_at is null;

create table if not exists pilot.shadow_chat_messages (
  message_id uuid primary key,
  conversation_id uuid not null references pilot.shadow_chat_sessions(conversation_id) on delete cascade,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  response_state text null check (response_state in ('ok', 'filtered')),
  topic text not null default 'general',
  session_type text not null default 'quick_round',
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_chat_messages_conversation
  on pilot.shadow_chat_messages(organization_id, account_id, conversation_id, created_at asc);

create table if not exists pilot.shadow_human_review_queue (
  review_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  conversation_id uuid null references pilot.shadow_chat_sessions(conversation_id) on delete set null,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  category text not null,
  severity text not null check (severity in ('moderate', 'high', 'critical')),
  summary text not null,
  status text not null default 'open'
    check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  metadata jsonb not null default '{}'::jsonb,
  reviewed_by text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_human_review_org_status
  on pilot.shadow_human_review_queue(organization_id, status, created_at desc);

create table if not exists pilot.shadow_data_deletion_requests (
  request_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'completed', 'denied')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz null,
  processed_by text null
);

create index if not exists idx_shadow_deletion_requests_org_status
  on pilot.shadow_data_deletion_requests(organization_id, status, requested_at desc);

create table if not exists pilot.shadow_chat_memory_corrections (
  correction_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  fact_key text not null,
  corrected_value text null,
  action text not null check (action in ('replace', 'forget')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'applied', 'denied')),
  reviewed_by_account_id text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_memory_corrections_owner
  on pilot.shadow_chat_memory_corrections(organization_id, account_id, created_at desc);

create table if not exists pilot.shadow_jobs (
  job_id uuid primary key default gen_random_uuid(),
  job_type text not null
    check (job_type in (
      'heavy_bag_session', 'scout_report', 'board_summary',
      'library_update', 'film_study', 'learning_loop'
    )),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  subject_id text null,
  role text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  input_payload jsonb not null default '{}'::jsonb,
  output_payload jsonb null,
  error_message text null
    check (error_message is null or error_message ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  safety_status text not null default 'pending'
    check (safety_status in ('pending', 'passed', 'filtered', 'not_applicable')),
  priority integer not null default 3 check (priority between 1 and 5),
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz null,
  completed_at timestamptz null,
  expires_at timestamptz not null default now() + interval '24 hours',
  foreign key (organization_id, subject_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_shadow_jobs_status_priority
  on pilot.shadow_jobs(status, priority asc, created_at asc)
  where status = 'pending';

create index if not exists idx_shadow_jobs_owner_created
  on pilot.shadow_jobs(organization_id, account_id, created_at desc);

create index if not exists idx_shadow_jobs_subject_created
  on pilot.shadow_jobs(organization_id, subject_id, created_at desc)
  where subject_id is not null;

create table if not exists pilot.shadow_research_requirements (
  research_requirement_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  source_event_name text not null,
  source_entity_type text not null,
  source_entity_id text not null,
  research_requirement text not null,
  knowledge_gap text not null,
  evidence_label text null,
  source_status text not null,
  source_confidence_tier text not null,
  source_verification_state text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by_account_id text not null,
  created_by_role text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz null,
  unique (organization_id, source_event_name, source_entity_type, source_entity_id)
);

create index if not exists idx_shadow_research_requirements_org_created
  on pilot.shadow_research_requirements(organization_id, created_at desc);

create table if not exists pilot.shadow_recommendation_effectiveness (
  effectiveness_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  feedback_id bigint null unique references pilot.shadow_feedback(feedback_id) on delete set null,
  recommendation_id text null,
  recommendation_type text not null,
  outcome text not null check (outcome in ('improved', 'neutral', 'degraded', 'unknown')),
  effectiveness_score numeric(4,3) null
    check (effectiveness_score between 0 and 1),
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'durable_client', 'human_reviewed')),
  human_review_required boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_shadow_recommendation_effectiveness_org_created
  on pilot.shadow_recommendation_effectiveness(organization_id, created_at desc);

create table if not exists pilot.shadow_learning_events (
  event_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  role text not null,
  feedback_id bigint not null references pilot.shadow_feedback(feedback_id) on delete cascade,
  shadow_event_id bigint null references pilot.shadow_events(shadow_event_id) on delete set null,
  message_id text not null,
  topic text not null default 'general',
  session_type text not null default 'quick_round',
  outcome_signal text not null,
  effectiveness_score numeric(4,3) null
    check (effectiveness_score between 0 and 1),
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'durable_client', 'human_reviewed')),
  human_review_required boolean not null default true,
  actions_taken jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (feedback_id, verification_state)
);

create index if not exists idx_learning_events_org_date
  on pilot.shadow_learning_events(organization_id, created_at desc);

create table if not exists pilot.shadow_library_review_flags (
  flag_id uuid primary key default gen_random_uuid(),
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text null references pilot.accounts(account_id) on delete set null,
  feedback_id bigint null references pilot.shadow_feedback(feedback_id) on delete set null,
  topic text not null,
  session_type text null,
  outcome_signal text null,
  user_note text null,
  flag_count integer not null default 1 check (flag_count >= 1),
  review_state text not null default 'pending'
    check (review_state in ('pending', 'approved', 'rejected', 'resolved')),
  proposed_action text null check (proposed_action in ('promote', 'demote', 'retain')),
  flagged_at timestamptz not null default now(),
  last_flagged_at timestamptz not null default now(),
  latest_outcome_signal text null,
  reviewed_by_account_id text null,
  reviewed_at timestamptz null,
  unique (organization_id, topic)
);

create index if not exists idx_shadow_library_review_flags_org_state
  on pilot.shadow_library_review_flags(organization_id, review_state, last_flagged_at desc);

create table if not exists pilot.shadow_monthly_stats (
  monthly_stat_id bigserial primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  interaction_count integer not null default 0 check (interaction_count >= 0),
  avg_filter_rate numeric(6,5) null check (avg_filter_rate between 0 and 1),
  avg_effectiveness_score numeric(6,5) null
    check (avg_effectiveness_score between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, month)
);

-- Typed, append-only observations for deterministic SHADOW formulas.
create table if not exists pilot.shadow_formula_observations (
  observation_id text primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text null,
  context_id text not null,
  observation_kind text not null,
  numeric_value numeric null,
  unit text not null,
  dimensions jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  source_type text not null,
  source_quality text not null
    check (source_quality in ('verified', 'high', 'moderate', 'low', 'failed')),
  source_reference_id text not null,
  source_quality_notes text null,
  idempotency_key text not null,
  supersedes_observation_id text null references pilot.shadow_formula_observations(observation_id),
  created_by_account_id text null references pilot.accounts(account_id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

alter table pilot.shadow_formula_observations
  add column if not exists dimensions jsonb not null default '{}'::jsonb,
  add column if not exists idempotency_key text;
update pilot.shadow_formula_observations
set idempotency_key = observation_id
where idempotency_key is null;
alter table pilot.shadow_formula_observations
  alter column idempotency_key set not null;
create unique index if not exists idx_shadow_formula_observations_idempotency
  on pilot.shadow_formula_observations(organization_id, idempotency_key);

create index if not exists idx_shadow_formula_observations_scope
  on pilot.shadow_formula_observations(
    organization_id, athlete_id, context_id, observation_kind, observed_at desc
  );
create unique index if not exists idx_shadow_formula_observations_supersedes
  on pilot.shadow_formula_observations(organization_id, supersedes_observation_id)
  where supersedes_observation_id is not null;

create table if not exists pilot.shadow_formula_results (
  result_id text primary key,
  calculation_key text not null,
  formula_id text not null,
  formula_version text not null,
  output_key text not null,
  policy_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text null,
  context_id text null,
  numeric_value numeric null,
  unit text not null,
  computed_at timestamptz not null,
  input_observation_ids text[] not null default '{}',
  provenance jsonb not null default '[]'::jsonb,
  validation_state text not null
    check (validation_state in ('valid', 'warning', 'invalid', 'insufficient', 'unsupported')),
  hard_blocks text[] not null default '{}',
  warnings text[] not null default '{}',
  confidence text not null
    check (confidence in ('HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT')),
  completeness numeric(6,5) not null check (completeness between 0 and 1),
  worst_source_quality text null,
  unavailable_reason text null,
  human_review_required boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

alter table pilot.shadow_formula_results
  add column if not exists calculation_key text,
  add column if not exists output_key text,
  add column if not exists policy_version text,
  add column if not exists parameters jsonb not null default '{}'::jsonb;
update pilot.shadow_formula_results
set calculation_key = coalesce(calculation_key, result_id),
    output_key = coalesce(output_key, 'value'),
    policy_version = coalesce(policy_version, formula_version)
where calculation_key is null
   or output_key is null
   or policy_version is null;
alter table pilot.shadow_formula_results
  alter column calculation_key set not null,
  alter column output_key set not null,
  alter column policy_version set not null;
create unique index if not exists idx_shadow_formula_results_calculation
  on pilot.shadow_formula_results(organization_id, calculation_key);

create index if not exists idx_shadow_formula_results_scope
  on pilot.shadow_formula_results(
    organization_id, athlete_id, formula_id, output_key, formula_version, computed_at desc
  );
create index if not exists idx_shadow_formula_results_output_scope
  on pilot.shadow_formula_results(
    organization_id, athlete_id, formula_id, output_key, formula_version, computed_at desc
  );

create table if not exists pilot.shadow_formula_baseline_snapshots (
  baseline_snapshot_id uuid primary key default gen_random_uuid(),
  calculation_key text not null,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  formula_id text not null,
  formula_version text not null,
  metric_key text not null,
  unit text not null,
  policy_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  window_size integer not null check (window_size between 1 and 1000),
  history_status text not null
    check (history_status in ('insufficient_history', 'building', 'adequate')),
  baseline_mean numeric null,
  baseline_sample_sd numeric null,
  observation_ids text[] not null default '{}',
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

alter table pilot.shadow_formula_baseline_snapshots
  add column if not exists calculation_key text,
  add column if not exists metric_key text,
  add column if not exists unit text,
  add column if not exists policy_version text,
  add column if not exists parameters jsonb not null default '{}'::jsonb;
update pilot.shadow_formula_baseline_snapshots
set calculation_key = coalesce(calculation_key, baseline_snapshot_id::text),
    metric_key = coalesce(metric_key, formula_id),
    unit = coalesce(unit, 'unitless'),
    policy_version = coalesce(policy_version, formula_version)
where calculation_key is null
   or metric_key is null
   or unit is null
   or policy_version is null;
alter table pilot.shadow_formula_baseline_snapshots
  alter column calculation_key set not null,
  alter column metric_key set not null,
  alter column unit set not null,
  alter column policy_version set not null;
create unique index if not exists idx_shadow_formula_baseline_calculation
  on pilot.shadow_formula_baseline_snapshots(
    organization_id, athlete_id, metric_key, calculation_key
  );

create index if not exists idx_shadow_formula_baseline_scope
  on pilot.shadow_formula_baseline_snapshots(
    organization_id, athlete_id, metric_key, formula_id, effective_at desc
  );
create index if not exists idx_shadow_formula_baseline_metric_scope
  on pilot.shadow_formula_baseline_snapshots(
    organization_id, athlete_id, metric_key, formula_id, effective_at desc
  );

do $shadow_formula_foundation_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_observations'::regclass
      and conname = 'shadow_formula_observations_dimensions_check'
  ) then
    alter table pilot.shadow_formula_observations
      add constraint shadow_formula_observations_dimensions_check
      check (jsonb_typeof(dimensions) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_observations'::regclass
      and conname = 'shadow_formula_observations_idempotency_key_check'
  ) then
    alter table pilot.shadow_formula_observations
      add constraint shadow_formula_observations_idempotency_key_check
      check (length(btrim(idempotency_key)) between 1 and 300);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_results'::regclass
      and conname = 'shadow_formula_results_identity_check'
  ) then
    alter table pilot.shadow_formula_results
      add constraint shadow_formula_results_identity_check
      check (
        length(btrim(calculation_key)) between 1 and 300
        and length(btrim(output_key)) between 1 and 120
        and length(btrim(policy_version)) between 1 and 120
        and jsonb_typeof(parameters) = 'object'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_baseline_snapshots'::regclass
      and conname = 'shadow_formula_baseline_identity_check'
  ) then
    alter table pilot.shadow_formula_baseline_snapshots
      add constraint shadow_formula_baseline_identity_check
      check (
        length(btrim(calculation_key)) between 1 and 300
        and length(btrim(metric_key)) between 1 and 200
        and length(btrim(unit)) between 1 and 80
        and length(btrim(policy_version)) between 1 and 120
        and jsonb_typeof(parameters) = 'object'
      );
  end if;
end
$shadow_formula_foundation_constraints$;

alter table pilot.shadow_feedback
  add column if not exists outcome_signal text null,
  add column if not exists correlation_type text null,
  add column if not exists correlation_id text null,
  add column if not exists verification_state text not null default 'unverified',
  add column if not exists human_review_required boolean not null default true,
  add column if not exists reviewed_by_account_id text null references pilot.accounts(account_id) on delete set null,
  add column if not exists reviewed_at timestamptz null;

do $shadow_feedback_constraints$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.shadow_feedback'::regclass
      and conname = 'shadow_feedback_verification_state_check'
  ) then
    alter table pilot.shadow_feedback
      add constraint shadow_feedback_verification_state_check
      check (verification_state in ('unverified', 'durable_client', 'human_reviewed'));
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.shadow_feedback'::regclass
      and conname = 'shadow_feedback_reviewed_by_account_id_fkey'
  ) then
    alter table pilot.shadow_feedback
      add constraint shadow_feedback_reviewed_by_account_id_fkey
      foreign key (reviewed_by_account_id)
      references pilot.accounts(account_id)
      on delete set null;
  end if;
end
$shadow_feedback_constraints$;

create index if not exists idx_shadow_feedback_correlation
  on pilot.shadow_feedback(organization_id, account_id, correlation_type, correlation_id);

create unique index if not exists idx_shadow_feedback_unique_message
  on pilot.shadow_feedback(organization_id, account_id, correlation_id)
  where correlation_type = 'shadow_message'
    and correlation_id is not null;

alter table pilot.shadow_authority_checks
  add column if not exists source_confidence_tier text null,
  add column if not exists source_verification_state text null;

-- Durable database-backed rate-limit buckets. These keep enforcement
-- consistent across container replicas and survive process restarts.
create table if not exists pilot.shadow_rate_limit_buckets (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  account_id text not null references pilot.accounts(account_id) on delete cascade,
  endpoint_key text not null,
  window_started_at timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 86400),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, account_id, endpoint_key, window_started_at)
);

create index if not exists idx_shadow_rate_limit_buckets_window
  on pilot.shadow_rate_limit_buckets(window_started_at, updated_at);
