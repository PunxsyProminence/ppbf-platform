-- The registry, and only the registry, decides what a drill's discipline may be.
--
-- OWNER DECISION, VERBATIM: "drop the check and let the registry govern."
-- Ratified 2026-08-28. This file executes exactly that and nothing else.
--
-- THIS MIGRATION IS NOT ADDITIVE. Every other migration in this repository
-- adds; this one REMOVES pilot_drill_library_discipline_check from
-- pilot.drill_library. There is no rollback tooling here, so that is said
-- plainly rather than left for a reader to discover.
--
-- WHY IT IS NEVERTHELESS SAFE TO REMOVE:
--
--   * Dropping a CHECK only ever WIDENS what a column accepts. No row is read,
--     no row is written, no row is altered, no value is rewritten, nothing is
--     deleted. Every row in the table before this statement is byte-identical
--     after it.
--   * The column does not become ungoverned. pilot_drill_library_discipline_fk
--     -- the composite key (organization_id, discipline) referencing
--     pilot.disciplines, installed by the drill-library-discipline-fk migration
--     -- continues to govern every new write. This file REFUSES TO RUN unless
--     that key is present; see the guard below, which is the most important
--     thing in it.
--   * Reversal is a one-line `alter table ... add constraint ... check (...)`
--     with the same five literals, which is why the absence of rollback tooling
--     is survivable here specifically. It would fail on any row written under a
--     discipline outside those five, which is the point of the change.
--
-- WHAT THE COLUMN MEANT BEFORE, AND WHAT IT MEANS AFTER.
--
--   BEFORE: a drill's discipline had to satisfy BOTH gates.
--
--     pilot_drill_library_discipline_check  (drill-library-v3, validated)
--         discipline in ('boxing','wrestling','combatives','conditioning','general')
--     pilot_drill_library_discipline_fk     (drill-library-discipline-fk, NOT VALID)
--         (organization_id, discipline) references pilot.disciplines
--
--   The seeded registry (apps/web/seed-data/multidiscipline/seed_disciplines.csv)
--   holds boxing, wrestling, bjj, combatives, conditioning. So the writable set
--   was the INTERSECTION of a hard-coded five-value list and each gym's own
--   registry, and that intersection had two holes, both recorded in the FK
--   migration's own header and both left there deliberately:
--
--     'bjj'      IS registered, and the CHECK refused it (SQLSTATE 23514,
--                measured). A gym that runs BJJ could not file a single BJJ
--                drill.
--     'general'  passes the CHECK and is in no registry, so the FK refused it
--                (SQLSTATE 23503, measured). Admitted by one gate, refused by
--                the other.
--
--   The FK migration wrote: "Resolving either means editing or dropping a
--   validated constraint, which changes what the column means. That is a
--   decision, not a cleanup, and it is not this migration's to make." The owner
--   has now made it.
--
--   AFTER: the discipline column means "a discipline THIS organization has
--   registered in pilot.disciplines". One authority, per-organization, and the
--   registry is where the exposure model, the lane, the governing body and the
--   youth policy are written -- so a drill's discipline now always resolves to
--   a row that answers those questions.
--
--   'bjj' becomes writable for a gym that registers it: refused with 23514
--   before, accepted after (measured in drillLibraryCheckDrop.pg.test.ts).
--
--   'general' does NOT become writable, and the measurement is worth stating
--   precisely because the obvious guess is wrong. A 'general' write is refused
--   with 23503 BEFORE the drop and 23503 AFTER it -- the same code, from the
--   same constraint. The CHECK never refused 'general'; it admitted it. The
--   foreign key was already the only thing in its way and it still is, so
--   dropping the CHECK changes nothing about that value at all. This migration
--   also fabricates no registry row to make it pass, which is the same refusal
--   the FK migration recorded.
--
--   A gym may now register a discipline of its own -- judo, sambo, anything it
--   actually runs -- and immediately file drills under it. That was impossible
--   before, because the CHECK capped EVERY organization at the same five
--   literals regardless of what any gym does.
--
-- THE EVIDENCE THE OWNER RATIFIED THIS ON.
--
--   apps/web/scripts/pilot-check-discipline-values.mjs is a read-only census of
--   the discipline values these tables actually hold. It ran against PRODUCTION
--   on 2026-08-28T14:17Z (workflow run 33175617223) and against staging earlier,
--   and both returned PILOT DISCIPLINE VALUE CENSUS: CLEAN --
--
--     0 organizations with no discipline registry at all;
--     0 rows in drill_library, session_scripts or cohort_definitions naming a
--       discipline the registry does not hold.
--
--   So production holds NO 'general' drill rows, and nothing in the table
--   depends on the CHECK's vocabulary. That census was read, not re-run: this
--   lane executed no query against any live database, and the claim above is
--   only as good as run 33175617223.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--
--   * It does not run `validate constraint` on the foreign key. The FK stays
--     NOT VALID exactly as it was found. Validating it is a separate decision
--     the owner has not made, and it is the statement that can fail on real
--     data.
--   * It does not enforce pilot.disciplines.active. An inactive registered
--     discipline remains writable, as it was before. Also unratified.
--   * It touches only pilot.drill_library. pilot.session_scripts and
--     pilot.cohort_definitions carry NO literal discipline CHECK at all
--     (verified by reading their migrations: both are `discipline text not null
--     default 'boxing'` with a registry FK and no CHECK), so there is nothing
--     equivalent to drop there and this decision named drill_library only.
--   * It alters no other constraint, role, permission or schema object.
--
-- DEPENDS ON pilot.drill_library (drill-library-v3) and on
-- pilot_drill_library_discipline_fk (drill-library-discipline-fk). It must run
-- AFTER BOTH in the `all` loop; migrationDispatchCoverage.test.ts asserts that
-- ordering. No begin;/commit; here on purpose, matching this repository's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-drill-library-check-drop-migration.mjs).

do $$
begin
  -- Fail loudly rather than skipping, the same way the FK migration does. A
  -- rebuild that reached this file without the table would otherwise report
  -- success having done nothing.
  if to_regclass('pilot.drill_library') is null then
    raise exception 'pilot.drill_library is missing: apply the drill-library-v3 migration first';
  end if;

  -- THE GUARD THAT MATTERS MOST, AND THE REASON THIS IS AN EXCEPTION RATHER
  -- THAN A SKIP.
  --
  -- This file removes one of the two things governing pilot.drill_library
  -- .discipline. If the other one is not installed, removing this one leaves
  -- the column as ungoverned free text with NOTHING checking it -- strictly
  -- worse than either state the owner was choosing between, and worse than
  -- doing nothing at all.
  --
  -- A silent skip is not an acceptable alternative. The dispatch would report
  -- PASS and the operator would believe the drop happened; the next person to
  -- look would find the CHECK still there and no record of why. So this raises,
  -- names the constraint that is missing, and names what to apply first.
  --
  -- contype = 'f' and confrelid are both checked, not the name alone: a
  -- constraint of some other kind carrying this name would satisfy a name-only
  -- lookup while governing nothing, and this guard would then hand over to an
  -- authority that does not exist.
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_drill_library_discipline_fk'
      and conrelid = to_regclass('pilot.drill_library')
      and contype = 'f'
      and confrelid = to_regclass('pilot.disciplines')
  ) then
    raise exception
      'pilot_drill_library_discipline_fk is missing from pilot.drill_library: '
      'refusing to drop pilot_drill_library_discipline_check, which would leave '
      'the discipline column ungoverned. Apply the drill-library-discipline-fk '
      'migration first.';
  end if;

  -- Idempotent: the `all` chain re-runs every migration on every dispatch, so
  -- the second pass has to survive the first. Keyed on the constraint's
  -- presence, so a re-apply after the drop is a no-op rather than an error.
  --
  -- `drop constraint if exists` alone would be enough for idempotency, but the
  -- catalog guard is kept because it makes the no-op explicit and matches the
  -- shape every other migration in this repository uses.
  if exists (
    select 1 from pg_constraint
    where conname = 'pilot_drill_library_discipline_check'
      and conrelid = to_regclass('pilot.drill_library')
      and contype = 'c'
  ) then
    alter table pilot.drill_library
      drop constraint pilot_drill_library_discipline_check;
  end if;
end $$;
