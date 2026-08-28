-- A drill's discipline must name a discipline its organization runs.
--
-- THE DEFECT. pilot.drill_library.discipline is `text not null default 'boxing'`
-- carrying a CHECK against a five-value literal list, and nothing else.
-- pilot.disciplines is the per-organization registry that declares what each
-- discipline IS -- its lane, its exposure model, its governing body, whether
-- youth may train it. Nothing connected the two, so a drill could name a
-- discipline the gym does not run and has recorded no safety model for.
--
-- That matters here for the same reason it matters for session scripts, and
-- more sharply: the registry is where "this discipline loads the neck" and
-- "youth may not train this" are written. A drill pointing at a discipline
-- with no registry row is a drill whose exposure model cannot be looked up.
-- It does not fail. It silently has no answer.
--
-- WHY A FOREIGN KEY WHEN THERE IS ALREADY A CHECK. The CHECK hard-codes ONE
-- vocabulary for EVERY organization. Which disciplines a gym runs is
-- per-organization data -- that is the entire reason pilot.disciplines is keyed
-- (organization_id, discipline) -- and a gym that has not adopted wrestling
-- should not be able to file wrestling drills merely because some other gym
-- might. The CHECK cannot express that; a composite foreign key is exactly the
-- thing that can.
--
-- Two tables already reference the registry this way -- pilot.grappling_exposure
-- and pilot.athlete_discipline_participation, both in the multidiscipline
-- migration. This is that pattern, applied to a table that predates it.
--
-- THE EXISTING CHECK IS LEFT IN PLACE, AND IT DISAGREES WITH THE REGISTRY.
-- This is deliberate, and it is the one thing about this migration a reviewer
-- should look at hardest.
--
--   pilot_drill_library_discipline_check admits:
--       boxing, wrestling, combatives, conditioning, general
--   the seeded registry contains:
--       boxing, wrestling, bjj, combatives, conditioning
--
--   So after this migration two contradictions remain, BOTH PRE-EXISTING and
--   NEITHER introduced here:
--
--     'general' passes the CHECK and fails the foreign key. It is not a
--       registered discipline anywhere and no row in any seed, fixture or test
--       uses it. It becomes unreachable for new writes.
--     'bjj' passes the foreign key and fails the CHECK. It IS a registered
--       discipline, and it remains unusable in this table.
--
--   Resolving either means editing or dropping a validated constraint, which
--   changes what the column means. That is a decision, not a cleanup, and it is
--   not this migration's to make -- so it is reported rather than taken. What
--   this file does is strictly additive: every value that was legal and
--   registered stays legal, and every unregistered value stops being writable.
--
-- NOT VALID, DELIBERATELY, AND THIS IS THE LOAD-BEARING DECISION.
--
--   `not valid` means: enforce this on every INSERT and UPDATE from now on,
--   and do NOT scan the rows already in the table.
--
--   Existing deployed rows are therefore preserved exactly as they are, whatever
--   they contain. Production was observed on 2026-08-24 to hold 119 drill
--   library rows (seed-reference-data run 32788628209) whose seed CSV carries
--   only boxing and conditioning, both registered -- but that is a loader's
--   output, not a read of the table, and staging and any other environment have
--   not been measured at all. A validating constraint would refuse to apply
--   against whatever it found and take the deploy down with it; worse, "fixing"
--   the rows to make it apply would mean rewriting deployed data on the basis
--   of an unmeasured guess.
--
--   In particular this migration does NOT invent a registry row to make any
--   existing value pass -- specifically NOT a 'general' row, which would give
--   an unregistered value the appearance of authority precisely because a
--   constraint was inconvenient.
--
--   Validation is a separate, later, deliberate act:
--
--     alter table pilot.drill_library
--       validate constraint pilot_drill_library_discipline_fk;
--
--   It is intentionally NOT in this file. Whoever runs it must first measure
--   the rows that exist, because it is the statement that can fail on real
--   data. Until then the constraint is doing its whole job for new writes.
--
-- SEEDING ORDER IS PART OF THIS CHANGE. seed-reference-data.yml loaded
-- drill-library BEFORE disciplines while describing itself as running "every
-- loader in dependency order". That was survivable only because no dependency
-- existed. It does now, so the workflow is corrected in the same commit: the
-- registry is filled before the table that references it.
--
-- DEPENDS ON pilot.disciplines (created by the multidiscipline migration) and
-- pilot.drill_library (created by the drill-library-v3 migration). Both must
-- precede this in the apply order; migrationDispatchCoverage.test.ts asserts
-- that they do -- and note the order is NOT obvious, because drill-library-v3
-- sits at 49 in the `all` list while the registry it must now reference is not
-- created until 62. No begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-drill-library-discipline-fk-migration.mjs).

do $$
begin
  -- Fail loudly rather than skipping. A rebuild that reached this file without
  -- the registry would otherwise install nothing and report success, and the
  -- constraint would be missing from an environment that believed it had it.
  if to_regclass('pilot.disciplines') is null then
    raise exception 'pilot.disciplines is missing: apply the multidiscipline migration first';
  end if;

  if to_regclass('pilot.drill_library') is null then
    raise exception 'pilot.drill_library is missing: apply the drill-library-v3 migration first';
  end if;

  -- Idempotent: the `all` chain re-runs every migration on every dispatch, so
  -- the second pass has to survive the first. Keyed on the constraint name
  -- rather than on a validity state, so re-applying after someone has
  -- validated it is still a no-op instead of an error.
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_drill_library_discipline_fk'
      and conrelid = to_regclass('pilot.drill_library')
  ) then
    alter table pilot.drill_library
      add constraint pilot_drill_library_discipline_fk
      foreign key (organization_id, discipline)
      references pilot.disciplines(organization_id, discipline)
      not valid;
  end if;
end $$;
