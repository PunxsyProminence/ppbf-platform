-- Compliance tables (audit task: schema ownership). Second of three.
--
-- WHY THIS EXISTS
--
-- pilot.compliance_rules, pilot.compliance_violations and
-- pilot.violation_escalations were created ONLY by
-- /api/pilot/admin/migrate-multiorg -- a bootstrap-key HTTP route issuing 125
-- DDL statements. No migration file owned them, so `apply-migrations` could
-- never create them under ANY choice including `all`:
-- pilot_slice_postgres_multiorg_migration.sql creates organizations,
-- organization_memberships, parents, staff, volunteers, skills, assessments,
-- attendance, readiness, documents and messages -- and none of these three.
--
-- Behind them sit /admin/compliance-center and /board/compliance-monitoring,
-- plus /api/pilot/compliance/{violations,escalate} and
-- /api/pilot/board/compliance-summary.
--
-- THIS IS A NO-OP AGAINST PRODUCTION, AND THAT IS THE POINT
--
-- These three are the one group in this series PROVEN to exist in production:
-- the owner opened /admin/compliance-center and the tiles rendered 0, and that
-- page renders '--' rather than '0' when its fetch fails (page.tsx
-- dataAuthoritative). A successful query means the tables are there. So this
-- migration must apply over a live install and change nothing.
--
-- The DDL below is therefore copied VERBATIM from the route rather than
-- rewritten, and everything is `if not exists`. The goal is to make the
-- migration path ABLE to produce this schema, so a rebuilt environment is not
-- silently missing it -- not to restate what production already has.
--
-- DEPENDS ON video_sessions
--
-- compliance_violations carries `references pilot.video_sessions(...)`, and
-- video_sessions is NOT in the base schema -- it became migration-owned only
-- in #125. Applying this migration to a database without that table fails at
-- the foreign key. The `all` loop already orders video-sessions ahead of this
-- one; dispatching `compliance` alone against a fresh environment requires
-- `video-sessions` first.

create schema if not exists pilot;

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

-- Both indexes are on compliance_violations; the route creates no index on
-- compliance_rules (its unique constraint provides one) or on
-- violation_escalations. The runner asserts exactly these two rather than
-- inventing a third, so it stays a faithful check on what the route produced.
create index if not exists idx_compliance_violations_org_athlete on pilot.compliance_violations(organization_id, athlete_id, created_at desc);
create index if not exists idx_compliance_violations_status on pilot.compliance_violations(organization_id, status, escalation_status);

comment on table pilot.compliance_violations is
  'Rule violations detected against an athlete. Owned by pilot_slice_postgres_compliance_migration.sql; also created by the legacy migrate-multiorg HTTP route, which must stay byte-compatible with this file.';
