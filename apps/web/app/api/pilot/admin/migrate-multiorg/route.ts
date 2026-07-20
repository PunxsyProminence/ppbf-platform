import { NextResponse, type NextRequest } from 'next/server';
import { Client } from 'pg';

import { getAzurePostgresConnectionString } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY?.trim() || '';
    const providedKey = request.headers.get('x-ppbf-bootstrap-key')?.trim() || '';

    if (!bootstrapKey) {
      throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
    }

    if (!providedKey || providedKey !== bootstrapKey) {
      throw new Error('Forbidden: invalid bootstrap key');
    }

    const statements = [
      `create schema if not exists pilot`,
      `create table if not exists pilot.organizations (
        organization_id text primary key,
        organization_name text not null,
        status text not null default 'active' check (status in ('active', 'inactive', 'suspended', 'pending')),
        created_by_account_id text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create table if not exists pilot.organization_memberships (
        account_id text not null,
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        role text not null check (role in ('platform_owner', 'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff')),
        active_flag boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (account_id, organization_id)
      )`,
      `create table if not exists pilot.scheduler_classes (
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        class_id text not null,
        title text not null,
        start_at timestamptz not null,
        end_at timestamptz not null,
        location text not null,
        capacity integer not null check (capacity > 0 and capacity <= 200),
        scheduled_by_account_id text not null,
        coach_account_id text not null,
        covering_coach_account_id text null,
        status text not null check (status in ('open', 'full', 'cancelled')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (organization_id, class_id)
      )`,
      `create table if not exists pilot.scheduler_registrations (
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        registration_id text not null,
        class_id text not null,
        athlete_id text not null,
        requested_by_role text not null check (requested_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
        requested_by_account_id text not null,
        parent_reviewed boolean not null default false,
        parent_reviewed_at timestamptz null,
        parent_reviewer_account_id text null,
        status text not null check (status in ('registered', 'waitlisted', 'cancelled')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (organization_id, registration_id),
        foreign key (organization_id, class_id) references pilot.scheduler_classes(organization_id, class_id) on delete cascade,
        foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.scheduler_coaching_requests (
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        request_id text not null,
        athlete_id text not null,
        requested_by_role text not null check (requested_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
        requested_by_account_id text not null,
        preferred_at timestamptz not null,
        goals text not null,
        status text not null check (status in ('pending', 'approved', 'declined')),
        assigned_coach_account_id text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (organization_id, request_id),
        foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.scheduler_attendance (
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        attendance_id text not null,
        class_id text not null,
        athlete_id text not null,
        status text not null check (status in ('present', 'absent', 'excused')),
        method text not null check (method in ('self', 'coach_override', 'admin_override')),
        checked_in_by_role text not null check (checked_in_by_role in ('athlete', 'parent', 'coach', 'organization_admin', 'admin')),
        checked_in_by_account_id text not null,
        note text not null default '',
        checked_in_at timestamptz not null,
        updated_at timestamptz not null default now(),
        primary key (organization_id, attendance_id),
        unique (organization_id, class_id, athlete_id),
        foreign key (organization_id, class_id) references pilot.scheduler_classes(organization_id, class_id) on delete cascade,
        foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.document_ingest_audit (
        audit_id bigserial primary key,
        occurred_at timestamptz not null default now(),
        status text not null check (status in ('success', 'failure')),
        file_name text null,
        message text null,
        details jsonb not null default '{}'::jsonb
      )`,
      `create table if not exists pilot.admin_capability_registry (
        organization_id text primary key references pilot.organizations(organization_id) on delete cascade,
        capabilities jsonb not null default '[]'::jsonb,
        updated_by_account_id text not null,
        updated_at timestamptz not null default now()
      )`,
      `create table if not exists pilot.admin_track_assignments (
        organization_id text primary key references pilot.organizations(organization_id) on delete cascade,
        assignments jsonb not null default '{}'::jsonb,
        updated_by_account_id text not null,
        updated_at timestamptz not null default now()
      )`,
      `create table if not exists pilot.admin_gym_capability_access (
        organization_id text primary key references pilot.organizations(organization_id) on delete cascade,
        capability_access jsonb not null default '{}'::jsonb,
        updated_by_account_id text not null,
        updated_at timestamptz not null default now()
      )`,
      `create table if not exists pilot.athlete_floor_plans (
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        plan_id text not null,
        athlete_id text not null,
        generated_at timestamptz not null,
        readiness text not null,
        athlete_name text not null,
        payload jsonb not null,
        created_by_account_id text not null,
        created_by_role text not null,
        created_at timestamptz not null default now(),
        primary key (organization_id, plan_id),
        foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.shadow_chat_audit (
        chat_audit_id bigserial primary key,
        organization_id text not null references pilot.organizations(organization_id) on delete cascade,
        user_id text not null,
        user_role text not null,
        athlete_id text null,
        user_message text not null,
        shadow_response text not null,
        was_filtered boolean not null default false,
        created_at timestamptz not null default now()
      )`,
      `alter table pilot.accounts add column if not exists organization_id text`,
      `alter table pilot.accounts add column if not exists is_platform_owner boolean not null default false`,
      `alter table pilot.session_tokens add column if not exists organization_id text`,
      `alter table pilot.athletes add column if not exists organization_id text`,
      `alter table pilot.goals add column if not exists organization_id text`,
      `alter table pilot.sessions add column if not exists organization_id text`,
      `alter table pilot.coach_reviews add column if not exists organization_id text`,
      `alter table pilot.shadow_intake add column if not exists organization_id text`,
      `alter table pilot.audit_events add column if not exists organization_id text`,
      `create index if not exists idx_scheduler_classes_org_start on pilot.scheduler_classes(organization_id, start_at asc)`,
      `create index if not exists idx_scheduler_registrations_org_class on pilot.scheduler_registrations(organization_id, class_id, status)`,
      `create index if not exists idx_scheduler_registrations_org_athlete on pilot.scheduler_registrations(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_scheduler_coaching_requests_org_athlete on pilot.scheduler_coaching_requests(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_scheduler_attendance_org_class on pilot.scheduler_attendance(organization_id, class_id, checked_in_at desc)`,
      `create index if not exists idx_document_ingest_audit_occurred_at on pilot.document_ingest_audit(occurred_at desc)`,
      `create index if not exists idx_athlete_floor_plans_org_athlete_generated on pilot.athlete_floor_plans(organization_id, athlete_id, generated_at desc)`,
      `create index if not exists idx_admin_track_assignments_updated on pilot.admin_track_assignments(updated_at desc)`,
      `create index if not exists idx_admin_gym_capability_access_updated on pilot.admin_gym_capability_access(updated_at desc)`,
      `create index if not exists idx_shadow_chat_audit_org_created on pilot.shadow_chat_audit(organization_id, created_at desc)`,
      `create index if not exists idx_shadow_chat_audit_user_created on pilot.shadow_chat_audit(user_id, created_at desc)`,
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ('ppbf-default-org', 'PPBF Default Organization', 'active')
       on conflict (organization_id) do nothing`,
      `update pilot.accounts set organization_id='ppbf-default-org' where organization_id is null`,
      `update pilot.athletes set organization_id='ppbf-default-org' where organization_id is null`,
      `update pilot.goals set organization_id='ppbf-default-org' where organization_id is null`,
      `update pilot.sessions set organization_id='ppbf-default-org' where organization_id is null`,
      `update pilot.coach_reviews set organization_id='ppbf-default-org' where organization_id is null`,
      `update pilot.shadow_intake set organization_id='ppbf-default-org' where organization_id is null`,
      `update pilot.audit_events set organization_id='ppbf-default-org' where organization_id is null`,
      `alter table pilot.athletes alter column organization_id set not null`,
      `do $$
       begin
         if exists (
           select 1
           from pg_constraint c
           join pg_class r on r.oid = c.conrelid
           join pg_namespace n on n.oid = r.relnamespace
           where n.nspname = 'pilot'
             and r.relname = 'athletes'
             and c.conname = 'athletes_pkey'
         ) then
           execute 'alter table pilot.athletes drop constraint athletes_pkey cascade';
         end if;

         if exists (
           select 1
           from pg_constraint c
           join pg_class r on r.oid = c.conrelid
           join pg_namespace n on n.oid = r.relnamespace
           where n.nspname = 'pilot'
             and r.relname = 'athletes'
             and c.conname = 'pilot_athletes_pk'
         ) then
           execute 'alter table pilot.athletes drop constraint pilot_athletes_pk cascade';
         end if;
       end $$`,
      `do $$
       begin
         alter table pilot.athletes add constraint pilot_athletes_pk primary key (organization_id, athlete_id);
       exception when duplicate_object then
         null;
       end $$`,
      `do $$
       begin
         if exists (
           select 1
           from pg_constraint c
           join pg_class r on r.oid = c.conrelid
           join pg_namespace n on n.oid = r.relnamespace
           where n.nspname = 'pilot'
             and r.relname = 'goals'
             and c.conname in ('goals_pkey', 'pilot_goals_pk')
         ) then
           alter table pilot.goals drop constraint if exists goals_pkey cascade;
           alter table pilot.goals drop constraint if exists pilot_goals_pk cascade;
         end if;
       end $$`,
      `do $$
       begin
         alter table pilot.goals add constraint pilot_goals_pk primary key (organization_id, goal_id);
       exception when duplicate_object then
         null;
       end $$`,
      `do $$
       begin
         if exists (
           select 1
           from pg_constraint c
           join pg_class r on r.oid = c.conrelid
           join pg_namespace n on n.oid = r.relnamespace
           where n.nspname = 'pilot'
             and r.relname = 'sessions'
             and c.conname in ('sessions_pkey', 'pilot_sessions_pk')
         ) then
           alter table pilot.sessions drop constraint if exists sessions_pkey cascade;
           alter table pilot.sessions drop constraint if exists pilot_sessions_pk cascade;
         end if;
       end $$`,
      `do $$
       begin
         alter table pilot.sessions add constraint pilot_sessions_pk primary key (organization_id, session_id);
       exception when duplicate_object then
         null;
       end $$`,
      `do $$
       begin
         if exists (
           select 1
           from pg_constraint c
           join pg_class r on r.oid = c.conrelid
           join pg_namespace n on n.oid = r.relnamespace
           where n.nspname = 'pilot'
             and r.relname = 'coach_reviews'
             and c.conname in ('coach_reviews_pkey', 'pilot_coach_reviews_pk')
         ) then
           alter table pilot.coach_reviews drop constraint if exists coach_reviews_pkey cascade;
           alter table pilot.coach_reviews drop constraint if exists pilot_coach_reviews_pk cascade;
         end if;
       end $$`,
      `do $$
       begin
         alter table pilot.coach_reviews add constraint pilot_coach_reviews_pk primary key (organization_id, review_id);
       exception when duplicate_object then
         null;
       end $$`,
      `do $$
       begin
         if exists (
           select 1
           from pg_constraint c
           join pg_class r on r.oid = c.conrelid
           join pg_namespace n on n.oid = r.relnamespace
           where n.nspname = 'pilot'
             and r.relname = 'shadow_intake'
             and c.conname in ('shadow_intake_pkey', 'pilot_shadow_intake_pk')
         ) then
           alter table pilot.shadow_intake drop constraint if exists shadow_intake_pkey cascade;
           alter table pilot.shadow_intake drop constraint if exists pilot_shadow_intake_pk cascade;
         end if;
       end $$`,
      `do $$
       begin
         alter table pilot.shadow_intake add constraint pilot_shadow_intake_pk primary key (organization_id, intake_id);
       exception when duplicate_object then
         null;
       end $$`,
      `alter table pilot.accounts drop constraint if exists accounts_role_check`,
      `alter table pilot.accounts add constraint accounts_role_check check (role in ('platform_owner', 'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff'))`,
      `create unique index if not exists uq_pilot_accounts_org_account on pilot.accounts(organization_id, account_id)`,
      `create unique index if not exists uq_pilot_athletes_org_athlete on pilot.athletes(organization_id, athlete_id)`,
      `create table if not exists pilot.intake_cases (
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
      )`,
      `create table if not exists pilot.intake_documents (
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
      )`,
      `create table if not exists pilot.documents (
        organization_id text not null references pilot.organizations(organization_id),
        document_id uuid not null,
        owner_entity_type text not null,
        owner_entity_id text not null,
        storage_path text not null,
        classification text not null,
        created_by_account_id text not null references pilot.accounts(account_id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_documents_pk primary key (organization_id, document_id)
      )`,
      `create table if not exists pilot.emergency_contacts (
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
      )`,
      `create table if not exists pilot.medical_intake (
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
      )`,
      `create table if not exists pilot.waivers (
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
      )`,
      `create table if not exists pilot.parents (
        organization_id text not null references pilot.organizations(organization_id),
        parent_id text not null,
        account_id text null references pilot.accounts(account_id),
        full_name text not null,
        phone text null,
        email text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (organization_id, parent_id)
      )`,
      `create table if not exists pilot.guardian_links (
        organization_id text not null references pilot.organizations(organization_id),
        parent_id text not null,
        athlete_id text not null,
        relationship_to_athlete text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_guardian_links_pk primary key (organization_id, parent_id, athlete_id),
        constraint pilot_guardian_links_parent_fk foreign key (organization_id, parent_id) references pilot.parents(organization_id, parent_id) on delete cascade,
        constraint pilot_guardian_links_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.assessments (
        organization_id text not null references pilot.organizations(organization_id),
        assessment_id uuid not null,
        athlete_id text not null,
        assessor_account_id text not null references pilot.accounts(account_id),
        assessment_type text not null,
        result jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_assessments_pk primary key (organization_id, assessment_id),
        constraint pilot_assessments_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.attendance (
        organization_id text not null references pilot.organizations(organization_id),
        attendance_id uuid not null,
        athlete_id text not null,
        attendance_date date not null,
        status text not null,
        notes text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_attendance_pk primary key (organization_id, attendance_id),
        constraint pilot_attendance_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.readiness (
        organization_id text not null references pilot.organizations(organization_id),
        readiness_id uuid not null,
        athlete_id text not null,
        score numeric(5,2) not null,
        category text not null,
        measured_at timestamptz not null,
        recovery_notes text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_readiness_pk primary key (organization_id, readiness_id),
        constraint pilot_readiness_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.coach_observations (
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
      )`,
      `create table if not exists pilot.announcements (
        organization_id text not null references pilot.organizations(organization_id),
        announcement_id uuid not null,
        message text not null,
        author_name text not null,
        author_role text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_announcements_pk primary key (organization_id, announcement_id)
      )`,
      `create index if not exists idx_pilot_intake_cases_org_status on pilot.intake_cases(organization_id, status, updated_at desc)`,
      `create index if not exists idx_pilot_intake_documents_org_case on pilot.intake_documents(organization_id, intake_case_id, created_at desc)`,
      `create index if not exists idx_pilot_documents_owner on pilot.documents(organization_id, owner_entity_type, owner_entity_id, created_at desc)`,
      `create index if not exists idx_pilot_emergency_contacts_org_athlete on pilot.emergency_contacts(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_pilot_medical_intake_org_athlete on pilot.medical_intake(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_pilot_waivers_org_athlete on pilot.waivers(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_pilot_guardian_links_org_athlete on pilot.guardian_links(organization_id, athlete_id)`,
      `create index if not exists idx_pilot_assessments_org_athlete on pilot.assessments(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_pilot_attendance_org_athlete on pilot.attendance(organization_id, athlete_id, attendance_date desc)`,
      `create index if not exists idx_pilot_readiness_org_athlete on pilot.readiness(organization_id, athlete_id, measured_at desc)`,
      `create index if not exists idx_pilot_coach_observations_org_athlete on pilot.coach_observations(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_pilot_announcements_org_created on pilot.announcements(organization_id, created_at desc)`,
      `create table if not exists pilot.shadow_authority_checks (
        authority_check_id bigserial primary key,
        organization_id text not null,
        actor_account_id text null,
        actor_role text null,
        action text not null,
        automation_mode text not null,
        confidence_tier text not null,
        allowed boolean not null,
        reason text not null,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )`,
      `create index if not exists idx_shadow_authority_checks_org_created on pilot.shadow_authority_checks(organization_id, created_at desc)`,
      `create table if not exists pilot.shadow_events (
        shadow_event_id bigserial primary key,
        organization_id text not null,
        event_name text not null,
        entity_type text not null,
        entity_id text not null,
        actor_account_id text null,
        actor_role text null,
        payload jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )`,
      `create index if not exists idx_shadow_events_org_created on pilot.shadow_events(organization_id, created_at desc)`,
      `create table if not exists pilot.shadow_telemetry_events (
        shadow_telemetry_event_id bigserial primary key,
        organization_id text not null,
        metric_name text not null,
        actor_account_id text null,
        actor_role text null,
        dimensions jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )`,
      `create index if not exists idx_shadow_telemetry_org_created on pilot.shadow_telemetry_events(organization_id, created_at desc)`,
      `create table if not exists pilot.shadow_library_sources (
        source_id text primary key,
        organization_id text not null,
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
      )`,
      `create table if not exists pilot.shadow_library_documents (
        document_id text primary key,
        source_id text not null references pilot.shadow_library_sources(source_id) on delete cascade,
        organization_id text not null,
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
      )`,
      `create table if not exists pilot.shadow_library_capability_map (
        capability_map_id text primary key,
        organization_id text not null,
        capability_key text not null,
        required_source_types text[] not null default '{}'::text[],
        minimum_authority_tier smallint not null default 3,
        minimum_source_count smallint not null default 1,
        coverage_state text not null default 'unknown',
        last_evaluated_at timestamptz null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (organization_id, capability_key)
      )`,
      `create table if not exists pilot.shadow_library_chunks (
        chunk_id text primary key,
        document_id text not null references pilot.shadow_library_documents(document_id) on delete cascade,
        source_id text not null references pilot.shadow_library_sources(source_id) on delete cascade,
        organization_id text not null,
        subject_id text null,
        ordinal int not null,
        text_content text not null,
        metadata jsonb not null default '{}'::jsonb,
        created_by_account_id text null,
        created_by_role text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (document_id, ordinal)
      )`,
      `create index if not exists idx_shadow_library_sources_org_created on pilot.shadow_library_sources(organization_id, created_at desc)`,
      `create index if not exists idx_shadow_library_documents_org_created on pilot.shadow_library_documents(organization_id, created_at desc)`,
      `create index if not exists idx_shadow_library_cap_map_org_updated on pilot.shadow_library_capability_map(organization_id, updated_at desc)`,
      `create index if not exists idx_shadow_library_chunks_org_created on pilot.shadow_library_chunks(organization_id, created_at desc)`,
      `create table if not exists pilot.video_sessions (
        video_session_id text primary key,
        organization_id text not null,
        uploaded_by_account_id text not null,
        athlete_id text null,
        title text not null,
        notes text not null default '',
        blob_path text not null,
        file_name text not null,
        file_size_bytes bigint not null,
        mime_type text not null,
        status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'error', 'archived')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists idx_video_sessions_org_created on pilot.video_sessions(organization_id, created_at desc)`,
      `create index if not exists idx_video_sessions_athlete on pilot.video_sessions(organization_id, athlete_id, created_at desc)`,
      
      // Compliance Monitoring tables
      `create table if not exists pilot.compliance_rules (
        rule_id text primary key,
        organization_id text not null references pilot.organizations(organization_id),
        rule_name text not null,
        rule_category text not null check (rule_category in ('safety', 'technique', 'protocol', 'medical', 'behavioral')),
        description text not null,
        detection_logic text not null,
        severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low')),
        escalation_level text not null default 'coach' check (escalation_level in ('coach', 'admin', 'board', 'parent')),
        active_flag boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_compliance_rules_unique_name unique (organization_id, rule_name)
      )`,
      `create table if not exists pilot.compliance_violations (
        violation_id text primary key,
        organization_id text not null references pilot.organizations(organization_id),
        rule_id text not null references pilot.compliance_rules(rule_id),
        video_session_id text null references pilot.video_sessions(video_session_id),
        athlete_id text not null,
        detected_by_account_id text not null references pilot.accounts(account_id),
        violation_timestamp timestamptz not null,
        severity text not null,
        details jsonb not null default '{}'::jsonb,
        evidence_path text null,
        status text not null default 'new' check (status in ('new', 'acknowledged', 'escalated', 'resolved', 'dismissed')),
        escalation_status text not null default 'pending' check (escalation_status in ('pending', 'in_progress', 'resolved', 'escalated_to_board')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pilot_compliance_violations_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
      )`,
      `create table if not exists pilot.violation_escalations (
        escalation_id text primary key,
        organization_id text not null references pilot.organizations(organization_id),
        violation_id text not null references pilot.compliance_violations(violation_id) on delete cascade,
        escalated_by_account_id text not null references pilot.accounts(account_id),
        escalated_to_role text not null,
        escalation_reason text not null,
        board_notification_id text null,
        action_required text null,
        resolved_at timestamptz null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists idx_compliance_violations_org_athlete on pilot.compliance_violations(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_compliance_violations_status on pilot.compliance_violations(organization_id, status, escalation_status)`,
      
      // Progression Intelligence tables
      `create table if not exists pilot.progression_gaps (
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
      )`,
      `create table if not exists pilot.drill_assignments (
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
      )`,
      `create table if not exists pilot.assignment_completions (
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
      )`,
      `create index if not exists idx_progression_gaps_athlete on pilot.progression_gaps(organization_id, athlete_id, created_at desc)`,
      `create index if not exists idx_drill_assignments_status on pilot.drill_assignments(organization_id, status, due_date)`,
      `create index if not exists idx_assignment_completions_assignment on pilot.assignment_completions(organization_id, assignment_id)`,
      
      // Publication Workflow tables
      `create table if not exists pilot.video_publications (
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
      )`,
      `create table if not exists pilot.publication_checks (
        check_id text primary key,
        organization_id text not null references pilot.organizations(organization_id),
        publication_id text not null references pilot.video_publications(publication_id) on delete cascade,
        check_type text not null check (check_type in ('compliance', 'safety', 'metadata', 'consent', 'legal')),
        check_status text not null check (check_status in ('passed', 'failed', 'warning', 'manual_review')),
        details text not null,
        checked_by_account_id text null references pilot.accounts(account_id),
        checked_at timestamptz null,
        created_at timestamptz not null default now()
      )`,
      `create table if not exists pilot.research_library (
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
      )`,
      `create index if not exists idx_video_publications_status on pilot.video_publications(organization_id, status, created_at desc)`,
      `create index if not exists idx_research_library_published on pilot.research_library(organization_id, published_at desc)`,
      `create index if not exists idx_research_library_tags on pilot.research_library(organization_id, tags)`,
      
      // Seed default compliance rules for each organization
      `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
       select 
         'rule_safety_' || organization_id || '_physical_injury',
         organization_id,
         'Physical Injury Prevention',
         'safety',
         'Prevents unsafe techniques and movements that could result in physical injury',
         'Monitor for high-impact movements, improper form, equipment misuse',
         'critical',
         'admin',
         true
       from pilot.organizations
       where organization_id not in (select organization_id from pilot.compliance_rules where rule_name = 'Physical Injury Prevention')
       on conflict do nothing`,
      `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
       select 
         'rule_technique_' || organization_id || '_form_standards',
         organization_id,
         'Proper Technique & Form',
         'technique',
         'Ensures athletes maintain proper form and technique during training',
         'Verify stance, grip, positioning, and movement patterns match standards',
         'high',
         'coach',
         true
       from pilot.organizations
       where organization_id not in (select organization_id from pilot.compliance_rules where rule_name = 'Proper Technique & Form')
       on conflict do nothing`,
      `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
       select 
         'rule_protocol_' || organization_id || '_attendance',
         organization_id,
         'Training Protocol Compliance',
         'protocol',
         'Enforces attendance requirements, equipment readiness, and training protocols',
         'Track attendance, equipment checks, session prep completion',
         'high',
         'coach',
         true
       from pilot.organizations
       where organization_id not in (select organization_id from pilot.compliance_rules where rule_name = 'Training Protocol Compliance')
       on conflict do nothing`,
      `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
       select 
         'rule_medical_' || organization_id || '_clearance',
         organization_id,
         'Medical Clearance Status',
         'medical',
         'Ensures athletes have current medical clearance and health documentation',
         'Verify medical forms signed, physician clearance current, emergency contacts on file',
         'critical',
         'admin',
         true
       from pilot.organizations
       where organization_id not in (select organization_id from pilot.compliance_rules where rule_name = 'Medical Clearance Status')
       on conflict do nothing`,
      `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
       select 
         'rule_behavioral_' || organization_id || '_conduct',
         organization_id,
         'Code of Conduct',
         'behavioral',
         'Maintains organizational standards for athlete conduct and respect',
         'Monitor respect to coaches/teammates, sportsmanship, team values adherence',
         'medium',
         'coach',
         true
       from pilot.organizations
       where organization_id not in (select organization_id from pilot.compliance_rules where rule_name = 'Code of Conduct')
       on conflict do nothing`,
    ];

    const client = new Client({
      connectionString: getAzurePostgresConnectionString(),
      ssl: { rejectUnauthorized: false },
    });

    await client.connect();
    try {
      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Migration statement failed: ${statement}. Error: ${message}`);
        }
      }
    } finally {
      await client.end();
    }

    return NextResponse.json({ ok: true, applied: 'core_multiorg_ddl' });
  } catch (error) {
    return jsonError(error);
  }
}
