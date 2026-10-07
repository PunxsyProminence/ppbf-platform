-- ---------------------------------------------------------------------------
-- Add the source label "PPBF owner-authored" to pilot.drill_library.field_provenance.
--
-- OWNER DECISION, VERBATIM (OD-2026-10-06-026 ruling 4, Jason, 2026-10-07):
--   "PPBF owner-authored (Recommended)" -- "Use this label for your drills and
--   material."
-- The question it answered: "every drill carries a source label and none fits
-- drills you wrote yourself."
--
-- WHAT THIS DOES. pilot_drill_library_field_provenance_check (drill-library-v3)
-- admits exactly three literals: the source manual and the two REQUIRES FLOOR
-- VALIDATION drafts. This migration replaces it with the same three plus
-- 'PPBF owner-authored', under the SAME constraint name, so every reader that
-- addresses the constraint by name (the v3 runner's readiness query,
-- contentImport/vocabularies.ts and its pg mirror test) keeps working.
--
-- WIDENED, NEVER NARROWED. Every value the old CHECK accepted is still
-- accepted, so no existing row can be invalidated by applying this, and NO ROW
-- IS RELABELLED: the label exists for Jason's own material to carry from now
-- on; which drills are his is his to say, not this file's.
--
-- Same shape as drill_vocabulary_widening: find every CHECK on the column
-- through the catalog rather than trusting one name, drop them, add the
-- replacement with an explicit name. Re-running is a no-op that leaves exactly
-- one CHECK. The v3 migration's own `if not exists ... add constraint` guard
-- sees the name present and does not re-add the narrow list on a later `all`
-- run; this migration sits AFTER drill-library-v3 in that list and refuses to
-- run before it.
-- ---------------------------------------------------------------------------

do $$
declare
  existing record;
begin
  if to_regclass('pilot.drill_library') is null then
    raise exception 'DRILL_OWNER_AUTHORED_LABEL_NOT_READY: pilot.drill_library does not exist -- apply the drill library v3 migration first';
  end if;

  for existing in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'pilot'
      and rel.relname = 'drill_library'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%field_provenance%'
  loop
    execute format('alter table pilot.drill_library drop constraint %I', existing.conname);
  end loop;

  alter table pilot.drill_library
    add constraint pilot_drill_library_field_provenance_check
    check (field_provenance in (
      'PPBF source manual v3',
      'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION',
      'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION',
      'PPBF owner-authored'
    ));
end $$;

comment on constraint pilot_drill_library_field_provenance_check on pilot.drill_library is
  'How the fields were authored. PPBF owner-authored marks material the gym''s owner wrote himself (OD-2026-10-06-026 ruling 4); the two DRAFT values still require floor validation before a gym adopts the drill.';
