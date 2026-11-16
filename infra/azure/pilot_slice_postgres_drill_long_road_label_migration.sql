-- ---------------------------------------------------------------------------
-- Add the source label "Long Road practice" to pilot.drill_library.field_provenance.
--
-- OWNER DECISION (OD-2026-11-15-002 ruling 1, 2026-11-15). Jason's answer,
-- verbatim: "A: Add the label (Rec.)". The option it chose read: "The app gets
-- a 'Long Road practice' label. Your manuals and the Long Road stay told apart,
-- and no extra floor test is added."
-- The frozen Backbone drill records carry exactly 'Long Road practice'
-- (PK-201 A; 190 of the 256 lane-2 drills), so this literal is that string,
-- byte for byte: plain ASCII, 18 bytes, no trailing space.
--
-- NOT A DRAFT. It is not one of the two REQUIRES FLOOR VALIDATION values, so
-- drillFloorValidation.ts adds no floor-test step for it.
--
-- WHAT THIS DOES. Replaces pilot_drill_library_field_provenance_check (four
-- values since drill_owner_authored_label) with the same four plus 'Long Road
-- practice', under the SAME constraint name every reader addresses (the v3 and
-- owner-authored runners' readiness queries, contentImport/vocabularies.ts and
-- its pg mirror test).
--
-- WIDENED, NEVER NARROWED, AND NO ROW IS RELABELLED. Every value the old CHECK
-- accepted is still accepted, and nothing here updates a row.
--
-- LEAVES A WIDER CHECK ALONE. If exactly one field_provenance CHECK exists, it
-- carries the shared name, and it already contains every value below, this
-- returns without touching it. drill_owner_authored_label carries the same
-- guard for its own four values, which is what makes the `all` chain safe to
-- re-run once a 'Long Road practice' row exists: that earlier migration sees
-- its four values inside the five and leaves the five in place, instead of
-- re-adding four and failing on the stored row. Otherwise (a narrower check,
-- or more than one) every field_provenance CHECK is found through the catalog,
-- dropped, and this five-value list is added. Re-running is a no-op that
-- leaves exactly one CHECK. Sits after drill-owner-authored-label in the `all`
-- list and refuses to run before drill-library-v3.
-- ---------------------------------------------------------------------------

do $$
declare
  wanted constant text[] := array[
    'PPBF source manual v3',
    'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION',
    'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION',
    'PPBF owner-authored',
    'Long Road practice'
  ];
  existing record;
  check_count integer;
  named_def text;
begin
  if to_regclass('pilot.drill_library') is null then
    raise exception 'DRILL_LONG_ROAD_LABEL_NOT_READY: pilot.drill_library does not exist -- apply the drill library v3 migration first';
  end if;

  select count(*), max(pg_get_constraintdef(con.oid)) filter (
           where con.conname = 'pilot_drill_library_field_provenance_check')
    into check_count, named_def
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'pilot'
    and rel.relname = 'drill_library'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%field_provenance%';

  if check_count = 1
     and named_def is not null
     and not exists (
       select 1 from unnest(wanted) as value
       where strpos(named_def, quote_literal(value)) = 0
     ) then
    return;
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
      'PPBF owner-authored',
      'Long Road practice'
    ));

  comment on constraint pilot_drill_library_field_provenance_check on pilot.drill_library is
    'How the fields were authored. PPBF owner-authored marks material the gym''s owner wrote himself (OD-2026-10-06-026 ruling 4); Long Road practice is the label 190 of the frozen Backbone drills carry (OD-2026-11-15-002 ruling 1) and is not a draft; the two DRAFT values still require floor validation before a gym adopts the drill.';
end $$;
