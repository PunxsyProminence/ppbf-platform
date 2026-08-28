-- A cohort definition's discipline must name a discipline its organization runs.
--
-- THE DEFECT. pilot.cohort_definitions.discipline is
-- `text not null default 'boxing'` with no constraint of any kind -- the third
-- table carrying this exact column definition and this exact gap, after
-- session_scripts and drill_library. pilot.disciplines is the per-organization
-- registry that declares what each discipline IS -- its lane, its exposure
-- model, its governing body, whether youth may train it. Nothing connected the
-- two, so a cohort could carry any string at all and the platform would treat
-- it as a discipline: 'grappling' (which is a LANE, not a discipline), a typo,
-- or a discipline the gym does not run and has recorded no safety model for.
--
-- IT MATTERS MOST HERE, OF THE THREE. The other two tables hold content. This
-- one holds a gate.
--
-- Every cohort_definitions row carries contact_permitted -- one of none,
-- light_technical, controlled_sparring, open_sparring -- alongside regulatory
-- age bounds and the rulebook clause that imposes them. The table decides which
-- athletes share a room and how hard they may go in it.
--
-- The registry is where "this discipline's exposure model is positional
-- grappling", "this discipline loads the neck" and "youth may not train this"
-- are written. So a cohort naming a discipline with no registry row is a cohort
-- that has been granted a contact permission against a discipline whose risk
-- model does not exist. It does not fail. It silently has no answer, on the one
-- table of the three where the answer gates contact.
--
-- WHY A FOREIGN KEY AND NOT A CHECK. The vocabulary is per-organization data,
-- not a fixed list. A gym that runs boxing and conditioning has a different
-- legitimate set than one that also runs wrestling, and both are correct. A
-- CHECK would hard-code one answer for every organization and would have to be
-- migrated every time a gym adopted a discipline; the registry already exists
-- to hold this, and pilot.disciplines' primary key (organization_id,
-- discipline) is exactly the composite key an org-scoped reference needs.
--
-- Two tables already reference it this way -- pilot.grappling_exposure and
-- pilot.athlete_discipline_participation, both in the multidiscipline
-- migration. This is that pattern, applied to a table that predates it.
--
-- THE REFERENCE IS ORGANIZATION-SCOPED, and that is a tenancy property, not a
-- formality. Because both columns are in the key, a cohort in org B cannot
-- name a discipline that only org A has registered. A single-column FK to a
-- global discipline list would have admitted it.
--
-- NOT VALID, DELIBERATELY, AND THIS IS THE LOAD-BEARING DECISION.
--
--   `not valid` means: enforce this on every INSERT and UPDATE from now on,
--   and do NOT scan the rows already in the table.
--
--   Existing deployed rows are therefore preserved exactly as they are, whatever
--   they contain. That is required, not merely convenient. Production was
--   observed on 2026-08-24 to hold 6 cohort definitions against 5 registered
--   disciplines (seed-reference-data run 32788628209), and the seed CSV those
--   six came from carries 'boxing' on every row, so they would validate
--   cleanly -- but that is a loader's output, not a read of the table, and
--   staging and any other environment have not been measured at all. A
--   validating constraint would refuse to apply against whatever it found and
--   take the deploy down with it; worse, "fixing" the rows to make it apply
--   would mean rewriting deployed data on the basis of an unmeasured guess.
--
--   In particular this migration does NOT invent a registry row to make any
--   existing value pass. If a deployed row carries a discipline nobody
--   registered, that row survives and stays exactly as legible as it was, and
--   the question of what it should have been stays open for a human.
--
--   Validation is a separate, later, deliberate act:
--
--     alter table pilot.cohort_definitions
--       validate constraint pilot_cohortdef_discipline_fk;
--
--   It is intentionally NOT in this file. Whoever runs it must first measure
--   the rows that exist, because it is the statement that can fail on real
--   data. Until then the constraint is doing its whole job for new writes.
--
-- DEPENDS ON pilot.disciplines (created by the multidiscipline migration) and
-- pilot.cohort_definitions (created by the competence-cohorts migration). Both
-- must precede this in the apply order; migrationDispatchCoverage.test.ts asserts
-- that they do. No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-cohort-definitions-discipline-fk-migration.mjs).

do $$
begin
  -- Fail loudly rather than skipping. A rebuild that reached this file without
  -- the registry would otherwise install nothing and report success, and the
  -- constraint would be missing from an environment that believed it had it.
  if to_regclass('pilot.disciplines') is null then
    raise exception 'pilot.disciplines is missing: apply the multidiscipline migration first';
  end if;

  if to_regclass('pilot.cohort_definitions') is null then
    raise exception 'pilot.cohort_definitions is missing: apply the competence-cohorts migration first';
  end if;

  -- Idempotent: the `all` chain re-runs every migration on every dispatch, so
  -- the second pass has to survive the first. Keyed on the constraint name
  -- rather than on a validity state, so re-applying after someone has
  -- validated it is still a no-op instead of an error.
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_cohortdef_discipline_fk'
      and conrelid = to_regclass('pilot.cohort_definitions')
  ) then
    alter table pilot.cohort_definitions
      add constraint pilot_cohortdef_discipline_fk
      foreign key (organization_id, discipline)
      references pilot.disciplines(organization_id, discipline)
      not valid;
  end if;
end $$;
