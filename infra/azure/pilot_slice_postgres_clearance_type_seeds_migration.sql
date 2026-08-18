-- Default staff credential TYPES, seeded per organization -- P-05 follow-up.
--
-- WHAT EXISTED BEFORE THIS: pilot_slice_postgres_clearance_register_migration.sql
-- created pilot.clearance_types and left it empty. There was no admin UI to
-- add a row (clearanceRegister.ts exposes no create function -- deliberately;
-- this migration does not change that), so a gym provisioned the documented
-- way had a clearance register with nothing in it to register a document
-- against. The staff-credentials feature needs the platform's own common
-- names to exist before a coach can pick one to upload a document for.
--
-- WHAT THIS SEEDS, AND WHY THESE FOUR
--
-- The four categories the product ticket named by name for a youth combat
-- sport program: a governing-body safeguarding certification, a
-- governing-body coaching certification, a state-statutory background
-- check, and an emergency-response certification. validity_months values
-- are ordinary defaults for each category (SafeSport core training and CPR/
-- First Aid both run on an annual/biennial cycle depending on issuer; a
-- background check clearance is commonly treated as good for several years
-- before an organization requires a fresh one) -- a gym can edit or archive
-- any seeded row exactly like the compliance-rule-seeds migration lets a gym
-- edit or archive a default rule, and the guards below protect that edit the
-- same way.
--
-- THIS DOES NOT SEED WHO NEEDS WHAT. pilot.activity_clearance_requirements
-- stays untouched -- the clearance-register migration's own header is
-- emphatic that requirement rows are human-authored only, and naming a
-- credential TYPE is not the same claim as requiring it for an activity.
-- Nothing here infers a requirement, clears a person, or extends a date.
--
-- IDEMPOTENCE, mirroring pilot_slice_postgres_compliance_rule_seeds_migration.sql
-- exactly:
--
--   * `where organization_id not in (select ... where name = ...)` skips an
--     organization that already holds a clearance type under that NAME --
--     including one it archived (active = false) or edited the authority/
--     validity of. Archiving or editing a default is a decision, and the
--     next run of this migration must not overturn it.
--
--   * `on conflict do nothing` catches the renamed case: clearance_type_id is
--     deterministic ('ct_<slug>_<organization_id>'), so a row whose NAME
--     changed but whose deterministic id still matches collides with itself
--     on re-run and is discarded rather than duplicated.
--
-- IT SEEDS THE ORGANIZATIONS THAT EXIST WHEN IT RUNS, same limitation the
-- compliance-rule-seeds migration documents and accepts: an organization
-- created after this runs gets nothing until the migration is dispatched
-- again. Unlike that migration, this one does NOT also hook into
-- organization creation -- narrower footprint, on purpose, for a feature
-- whose own ticket asked only that a genuinely-missing seed be added, not
-- that seeding become a general per-organization-creation concern.
--
-- EXCEPT THE RESERVED ORGANIZATION. '__platform__' owns the platform SHADOW
-- evidence baseline (see the platform-library-scope migration) -- a shelf,
-- not a gym, with no staff to credential.
--
-- No `begin;`/`commit;`: the runner
-- (apps/web/scripts/pilot-apply-clearance-type-seeds-migration.mjs) opens the
-- transaction itself, matching the clearance-register and compliance-rule-
-- seeds runners.
--
-- DEPENDS ON pilot_slice_postgres_clearance_register_migration.sql
-- (pilot.clearance_types must already exist).

insert into pilot.clearance_types
  (organization_id, clearance_type_id, name, issuing_authority, authority_kind, validity_months, renewal_grace_days, active)
select
  organization_id,
  'ct_safesport_' || organization_id,
  'SafeSport Training',
  'U.S. Center for SafeSport',
  'governing_body',
  12,
  30,
  true
from pilot.organizations
where organization_id <> '__platform__'
  and organization_id not in (select organization_id from pilot.clearance_types where name = 'SafeSport Training')
on conflict do nothing;

insert into pilot.clearance_types
  (organization_id, clearance_type_id, name, issuing_authority, authority_kind, validity_months, renewal_grace_days, active)
select
  organization_id,
  'ct_usaboxing_coach_' || organization_id,
  'USA Boxing Coach Certification',
  'USA Boxing',
  'governing_body',
  12,
  30,
  true
from pilot.organizations
where organization_id <> '__platform__'
  and organization_id not in (select organization_id from pilot.clearance_types where name = 'USA Boxing Coach Certification')
on conflict do nothing;

insert into pilot.clearance_types
  (organization_id, clearance_type_id, name, issuing_authority, authority_kind, validity_months, renewal_grace_days, active)
select
  organization_id,
  'ct_background_check_' || organization_id,
  'Background Check',
  'PA Dept of Human Services',
  'state_statutory',
  60,
  60,
  true
from pilot.organizations
where organization_id <> '__platform__'
  and organization_id not in (select organization_id from pilot.clearance_types where name = 'Background Check')
on conflict do nothing;

insert into pilot.clearance_types
  (organization_id, clearance_type_id, name, issuing_authority, authority_kind, validity_months, renewal_grace_days, active)
select
  organization_id,
  'ct_cpr_first_aid_' || organization_id,
  'CPR/First Aid',
  'American Red Cross',
  'governing_body',
  24,
  30,
  true
from pilot.organizations
where organization_id <> '__platform__'
  and organization_id not in (select organization_id from pilot.clearance_types where name = 'CPR/First Aid')
on conflict do nothing;
