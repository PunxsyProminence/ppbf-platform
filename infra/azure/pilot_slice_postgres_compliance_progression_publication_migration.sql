-- Compliance monitoring, progression intelligence, and publication workflow
-- (nine pilot.* tables) -- promoting route-created tables into the migration path.
--
-- Same problem the video-sessions migration solved, one layer further in. The
-- ONLY definition of pilot.compliance_rules, compliance_violations,
-- violation_escalations, progression_gaps, drill_assignments,
-- assignment_completions, video_publications, publication_checks, and
-- research_library anywhere in this repository was inside the 938-line
-- bootstrap-key-protected handler at
-- apps/web/app/api/pilot/admin/migrate-multiorg/route.ts. So all nine exist in
-- an environment if and only if somebody once POSTed to that route there.
--
-- Three live feature areas read and write these tables --
-- src/server/pilot/compliance.ts, progression.ts, and publication.ts, behind
-- the /admin/compliance-center, /coach|athlete/progression-intelligence, and
-- publication routes. In an environment provisioned the documented way (the
-- apply-migrations workflow), every one of those endpoints answers
-- 'relation does not exist'. That is exactly how the volunteers feature was
-- broken in production from the day it shipped: schema that lived only in
-- application code.
--
-- The shape below is copied verbatim from that runtime DDL, so applying this
-- where the tables already exist is a no-op. No data is read or dropped.
-- Indexes are included because the runtime DDL created them; an environment
-- that got tables but not indexes would otherwise pass a table-only readiness
-- check while the compliance and publication queries stayed unindexed.
--
-- The five default compliance-rule seeds are carried over as well. They are
-- guarded by a NOT IN check per rule name and ON CONFLICT DO NOTHING, so they
-- insert once per organization and are safe to re-run.
--
-- ORDERING: pilot.video_publications and pilot.research_library reference
-- pilot.video_sessions, so this migration must run AFTER
-- pilot_slice_postgres_video_sessions_migration.sql. The 'all' list in
-- .github/workflows/apply-migrations.yml reflects that.

create table if not exists pilot.compliance_rules (
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
);

create table if not exists pilot.compliance_violations (
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
);

create table if not exists pilot.violation_escalations (
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
);

create index if not exists idx_compliance_violations_org_athlete on pilot.compliance_violations(organization_id, athlete_id, created_at desc);

create index if not exists idx_compliance_violations_status on pilot.compliance_violations(organization_id, status, escalation_status);

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

create index if not exists idx_progression_gaps_athlete on pilot.progression_gaps(organization_id, athlete_id, created_at desc);

create index if not exists idx_drill_assignments_status on pilot.drill_assignments(organization_id, status, due_date);

create index if not exists idx_assignment_completions_assignment on pilot.assignment_completions(organization_id, assignment_id);

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

create index if not exists idx_video_publications_status on pilot.video_publications(organization_id, status, created_at desc);

create index if not exists idx_research_library_published on pilot.research_library(organization_id, published_at desc);

create index if not exists idx_research_library_tags on pilot.research_library(organization_id, tags);

insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
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
on conflict do nothing;

insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
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
on conflict do nothing;

insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
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
on conflict do nothing;

insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
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
on conflict do nothing;

insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level, active_flag)
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
on conflict do nothing;
