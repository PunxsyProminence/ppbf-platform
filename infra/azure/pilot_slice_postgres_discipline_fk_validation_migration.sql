-- The three discipline foreign keys stop saying "we never checked these rows".
--
-- OWNER DECISION OD-2026-08-28-006, verbatim: "go with recommendation", against
-- a recommendation to validate them, prefaced by "i want to build it right even
-- if it take a bit more work". Read that entry in docs/current/OWNER_DECISIONS.md
-- before changing anything here; it carries the measurements this file rests on
-- and they were taken once, deliberately, rather than reasoned about.
--
-- WHAT NOT VALID ACTUALLY IS. #756, #757 and #758 installed composite foreign
-- keys from three training-content tables to pilot.disciplines(organization_id,
-- discipline), all three `not valid`:
--
--     pilot.drill_library       pilot_drill_library_discipline_fk
--     pilot.session_scripts     pilot_session_scripts_discipline_fk
--     pilot.cohort_definitions  pilot_cohortdef_discipline_fk
--
-- `not valid` was the right call then and it is not a temporary flag. It is a
-- PERMANENT MARKER IN THE CATALOG meaning "these rows were never scanned", and
-- it stays in pg_constraint.convalidated until somebody runs the statement
-- below. The rows have now been scanned -- twice, on 2026-08-28, against
-- production and staging -- and both came back CLEAN. The marker is therefore
-- a false statement about this schema, and leaving a false statement in place
-- because correcting it is tedious is the thing the owner's instruction
-- forbids.
--
-- Each of the three FK migrations wrote, in its own header, that validation
-- "is intentionally NOT in this file" and that "whoever runs it must first
-- measure the rows that exist". That measurement happened. This is that file.
--
--
-- ============================================================================
-- THIS MIGRATION CAN FAIL ON DATA. NO OTHER MIGRATION IN THIS TREE CAN.
-- ============================================================================
--
-- Every other migration here either ADDS an object or is a no-op on a second
-- pass. `validate constraint` is different in kind: it SCANS every existing row
-- in the table and REFUSES if any one of them violates the key. That is not a
-- defect to be guarded away -- it is the entire point of the statement, and the
-- reason the owner was asked before it was written.
--
-- The operational consequence, stated plainly so nobody discovers it during a
-- release: an `all` dispatch CAN STOP HERE, on an environment whose data has
-- drifted since the census. It stops cleanly -- Postgres rolls the statement
-- back, no row is read into a half-state, no row is written, altered or
-- deleted, and the constraint is left exactly as it was found: installed,
-- enforcing every new INSERT and UPDATE, and still `not valid`. Nothing is left
-- half-done. But the dispatch is red, and the migrations after this one in the
-- `all` list have not run.
--
-- AND POSTGRES NAMES ONLY ONE OFFENDING KEY. A failure reports the first row it
-- meets, not the set. An operator who responds by fixing that row and
-- validating again learns about the next one the same way, one dispatch at a
-- time, from a live database. Do not do that. Run the read-only census instead,
-- which reports every offending row across all three tables in one pass and
-- takes no lock:
--
--     npm run pilot:check-discipline-values          (from apps/web)
--
-- The evidence this was authorised on: that census returned
-- `PILOT DISCIPLINE VALUE CENSUS: CLEAN` against production on 2026-08-28
-- (workflow run 33175617223) and against staging earlier -- zero organizations
-- with no discipline registry, and zero rows in any of the three tables naming
-- a discipline their organization's registry does not hold. Those were real
-- rows rather than empty tables: seed-reference-data run 32788628209 loaded 119
-- drill library rows against the production host on 2026-08-24. This file did
-- not re-run either check and cannot; it records which run it trusts.
--
--
-- WHAT VALIDATION COSTS, MEASURED RATHER THAN ASSUMED
--
-- Measured on PostgreSQL 18.4, the version this repository's own .pg.test.ts
-- suites run against (OD-2026-08-28-006):
--
--     blocks reads on either table            NO
--     blocks writes on either table           NO
--     takes                                   ShareUpdateExclusiveLock on the
--                                             content table, RowShareLock on
--                                             the registry
--     therefore blocks                        ANALYZE, CREATE INDEX,
--                                             ADD COLUMN, and a second
--                                             validate -- on the content table
--                                             only
--     duration at production size (119 rows)  1 ms
--     duration at 5,000,000 rows              1.48 s
--     interruptible                           yes; cancels clean, convalidated
--                                             stays false
--     re-run on an already-validated key      1 ms, no re-scan, no lock on the
--                                             registry -- a catalog no-op
--
-- That last line is what makes this safe under the `all` chain, which re-runs
-- every migration on every dispatch. The guard below goes one better and does
-- not issue the statement at all once a constraint is validated.
--
--
-- THE GUARD SKIPS WHEN A CONSTRAINT IS ABSENT. IT DOES NOT RAISE.
--
-- This is the OPPOSITE of the drill-library-check-drop migration's guard, which
-- raises, and the difference is not a matter of taste. That migration DROPS a
-- constraint: applied where its replacement is missing it would leave a column
-- ungoverned, so refusing is the only correct answer there. This migration only
-- ever turns a `not valid` marker off. A missing constraint means there is
-- nothing to validate and nothing is made worse by moving on -- while raising
-- would take down an entire `all` dispatch, and every migration after this one
-- in it, on any environment that has not yet applied the three FK migrations.
-- Those run earlier in the `all` order, so in the normal path the keys are
-- there.
--
-- Note `to_regclass(...)` rather than `'pilot.drill_library'::regclass`. The
-- cast RAISES 42P01 on a database where the table does not exist yet;
-- to_regclass returns null, `conrelid = null` matches nothing, and the block
-- takes the skip branch. On a table-less environment the cast would defeat the
-- whole point of the guard, and it would do it before the guard was consulted.
--
-- `contype = 'f'` is checked rather than the name alone. A CHECK constraint
-- wearing a foreign key's name would satisfy a name-only lookup, and
-- `validate constraint` against it would mean something else entirely.
--
--
-- A SILENT SKIP IS THE FAILURE MODE THIS REPOSITORY HAS BEEN BITTEN BY.
--
-- Seven migrations once sat in infra/azure reachable by nothing at all and
-- looked covered to anyone counting files. A guard that quietly does nothing
-- and reports PASS is the same shape of problem: an operator reading a green
-- dispatch log cannot tell "validated" from "was not there". So every branch of
-- every block below emits `raise notice` naming the constraint and which of the
-- three things happened to it:
--
--     VALIDATED   the key was `not valid`; it has now been scanned and marked
--     NO-OP       the key was already validated; no statement was issued
--     SKIPPED     no foreign key of that name is installed on that table
--
-- Read the notices in the dispatch log. Three VALIDATED or NO-OP lines is the
-- expected result; a SKIPPED line means that environment does not carry that
-- key, and is a question to ask rather than a result to accept.
--
--
-- POSITION: LAST in the `all` list, after session-scripts-discipline-fk,
-- drill-library-discipline-fk and cohort-definitions-discipline-fk, which
-- create the three keys this validates. Applied before them it would find
-- nothing, skip all three, and report success while achieving nothing.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO: nothing is dropped, altered or
-- re-created, and no constraint definition changes. No registry row is
-- fabricated to make a row pass -- if a row does not satisfy a key, this
-- migration fails and a human decides what to do about that row. No
-- begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-discipline-fk-validation-migration.mjs).

do $$
declare
  constraint_state text;
begin
  select case when convalidated then 'validated' else 'not_valid' end
    into constraint_state
    from pg_constraint
   where conname = 'pilot_drill_library_discipline_fk'
     and conrelid = to_regclass('pilot.drill_library')
     and contype = 'f';

  if constraint_state is null then
    raise notice 'discipline-fk-validation SKIPPED pilot_drill_library_discipline_fk: no foreign key of that name is installed on pilot.drill_library, so there is nothing to validate. Apply drill-library-discipline-fk first if this environment is meant to carry it.';
  elsif constraint_state = 'validated' then
    raise notice 'discipline-fk-validation NO-OP pilot_drill_library_discipline_fk: already validated, no statement issued.';
  else
    alter table pilot.drill_library
      validate constraint pilot_drill_library_discipline_fk;
    raise notice 'discipline-fk-validation VALIDATED pilot_drill_library_discipline_fk: pilot.drill_library scanned, constraint no longer NOT VALID.';
  end if;
end $$;

do $$
declare
  constraint_state text;
begin
  select case when convalidated then 'validated' else 'not_valid' end
    into constraint_state
    from pg_constraint
   where conname = 'pilot_session_scripts_discipline_fk'
     and conrelid = to_regclass('pilot.session_scripts')
     and contype = 'f';

  if constraint_state is null then
    raise notice 'discipline-fk-validation SKIPPED pilot_session_scripts_discipline_fk: no foreign key of that name is installed on pilot.session_scripts, so there is nothing to validate. Apply session-scripts-discipline-fk first if this environment is meant to carry it.';
  elsif constraint_state = 'validated' then
    raise notice 'discipline-fk-validation NO-OP pilot_session_scripts_discipline_fk: already validated, no statement issued.';
  else
    alter table pilot.session_scripts
      validate constraint pilot_session_scripts_discipline_fk;
    raise notice 'discipline-fk-validation VALIDATED pilot_session_scripts_discipline_fk: pilot.session_scripts scanned, constraint no longer NOT VALID.';
  end if;
end $$;

do $$
declare
  constraint_state text;
begin
  select case when convalidated then 'validated' else 'not_valid' end
    into constraint_state
    from pg_constraint
   where conname = 'pilot_cohortdef_discipline_fk'
     and conrelid = to_regclass('pilot.cohort_definitions')
     and contype = 'f';

  if constraint_state is null then
    raise notice 'discipline-fk-validation SKIPPED pilot_cohortdef_discipline_fk: no foreign key of that name is installed on pilot.cohort_definitions, so there is nothing to validate. Apply cohort-definitions-discipline-fk first if this environment is meant to carry it.';
  elsif constraint_state = 'validated' then
    raise notice 'discipline-fk-validation NO-OP pilot_cohortdef_discipline_fk: already validated, no statement issued.';
  else
    alter table pilot.cohort_definitions
      validate constraint pilot_cohortdef_discipline_fk;
    raise notice 'discipline-fk-validation VALIDATED pilot_cohortdef_discipline_fk: pilot.cohort_definitions scanned, constraint no longer NOT VALID.';
  end if;
end $$;
