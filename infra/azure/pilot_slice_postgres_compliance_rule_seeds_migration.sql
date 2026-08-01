-- Default compliance rules, seeded per organization.
--
-- WHY THIS EXISTS
--
-- pilot_slice_postgres_compliance_migration.sql owns compliance_rules,
-- compliance_violations and violation_escalations, but it seeds nothing. The
-- five default rules were only ever inserted by
-- /api/pilot/admin/migrate-multiorg -- a bootstrap-key HTTP route -- so a gym
-- provisioned the documented way (dispatch apply-migrations, then create the
-- organization) starts with an EMPTY rule set. With no rules,
-- /admin/compliance-center and /board/compliance-monitoring have nothing to
-- monitor against, and compliance_violations has no rule_id to reference.
--
-- Every gym starts with these five. They are copied VERBATIM from the route's
-- insert statements rather than rewritten, for the same reason the compliance
-- migration copies its DDL: an environment built by migration must not differ
-- from one built by the route.
--
-- IDEMPOTENCE, AND WHY A GYM'S OWN EDITS SURVIVE
--
-- Two guards, both carried over from the original statements, both
-- load-bearing:
--
--   * `where organization_id not in (select ... where rule_name = ...)` skips
--     an organization that already holds a rule under that NAME -- including
--     one it archived (active_flag = false) or whose description, severity or
--     escalation level it rewrote. Archiving a default rule is a decision, and
--     the next run of this migration must not overturn it.
--
--   * `on conflict do nothing` catches the remaining case: an organization
--     that RENAMED a default rule. The name check no longer recognizes it, but
--     rule_id is deterministic ('rule_<category>_<organization_id>_<slug>'), so
--     the insert collides with the row already there and is discarded.
--
-- Between them a rule is seeded exactly once per organization however many
-- times this runs, and an edited rule is never restored to its default text.
-- A rule DELETED outright does come back on a later run: these are the
-- platform defaults, and a deleted row is indistinguishable from one that was
-- never seeded.
--
-- IT SEEDS THE ORGANIZATIONS THAT EXIST WHEN IT RUNS
--
-- Each statement selects `from pilot.organizations` at apply time. An
-- organization created AFTER this migration is applied receives no rules from
-- it and stays empty until the migration is dispatched again. Organization
-- creation does not seed.
--
-- No `begin;`/`commit;`: the runner
-- (apps/web/scripts/pilot-apply-compliance-rule-seeds-migration.mjs) opens the
-- transaction itself, matching the compliance and volunteer-program runners.
-- The shadow-runtime runner takes the opposite convention.
--
-- DEPENDS ON the compliance migration
--
-- pilot.compliance_rules must already exist. The `all` loop orders
-- `compliance` ahead of this one; dispatching `compliance-rule-seeds` alone
-- against a fresh environment requires `compliance` first.

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
