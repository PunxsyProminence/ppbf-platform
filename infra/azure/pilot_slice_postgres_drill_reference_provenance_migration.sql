-- Drill reference provenance -- OD-2026-09-16-001, the hybrid drill model.
--
-- WHAT THIS ADDS: one nullable column on pilot.drills recording WHICH reference
-- drill an operational drill was promoted from, a composite foreign key so that
-- pointer can only ever reach this gym's own reference drill, and a partial
-- unique index so one reference drill cannot be promoted twice inside one gym.
--
-- WHY A NEW COLUMN AND NOT AN EXISTING ONE. Every candidate already on
-- pilot.drills was examined and each fails for a structural reason, not a
-- stylistic one:
--   * supersedes_drill_id / superseded_by_drill_id are nullable text, but both
--     carry composite self-foreign-keys to pilot.drills
--     (pilot_drills_supersedes_fk, pilot_drills_superseded_by_fk). A
--     drill_library id written there cannot resolve and the key refuses it.
--   * lineage_id is NOT NULL, is filled by pilot_drills_default_lineage_id when
--     omitted, and is covered by pilot_drills_lineage_version_uq. It means
--     "every version of this same operational drill". Writing a reference id
--     there would make two independent promotions of one reference drill look
--     like two versions of each other and corrupt the version chain.
--   * source_ref does not exist on pilot.drills at all, and on
--     pilot.drill_cues it means authoring lineage rather than a row pointer --
--     OD-2026-09-15-001 ruled on exactly that, and OD-2026-09-16-001 therefore
--     asks for a dedicated reference_drill_id instead.
--
-- NULLABLE, AND THAT IS THE CONTRACT, not a compromise. A gym authors drills of
-- its own; those have no reference source and must stay valid. This is the same
-- reasoning that added pilot.drill_assignments.drill_id nullable rather than
-- rewriting every assignment that predated the drill table.
--
-- NO BACKFILL. Nothing here guesses that an existing operational drill came
-- from a reference drill. A drill that was typed by a coach was typed by a
-- coach, and inferring provenance from a matching name is precisely the false
-- link this column exists to replace.
--
-- THE FOREIGN KEY IS COMPOSITE, carrying organization_id, for the reason
-- pilot_drill_assignments_fk_drill and the drill_versioning self-keys already
-- state: a scalar pointer would let one gym's operational drill reference
-- another gym's reference drill, and organization isolation would hold
-- everywhere except here.
--
-- AND IT DOES NOT CASCADE. pilot.drill_library children cascade FROM
-- drill_library because they are parts of that drill. A promoted operational
-- drill is not a part of it: it is the gym's own assignable identity, and
-- pilot.drill_assignments references it under ON DELETE RESTRICT. If this key
-- cascaded, removing reference content would delete assignable drills out from
-- under the assignments that point at them. NO ACTION is therefore deliberate:
-- an attempt to delete a promoted reference drill is refused, which is the
-- honest outcome -- the gym has adopted it.
--
-- DUPLICATE PROTECTION IS AN INDEX, not application logic. Two coaches clicking
-- Promote at the same moment each read no existing promotion and both write, so
-- only a unique index can hold "promote once per reference drill". It is
-- PARTIAL because NULL is not a duplicate: a gym may author any number of
-- unpromoted drills. pilot_drills_one_name_per_org, the existing partial unique
-- index on (organization_id, name) where active, does NOT cover this: a second
-- promotion under a different operational name satisfies it completely, and the
-- only thing that identifies the two rows as the same drill is this pointer.
--
-- Deliberately NOT partial on `active`, unlike the name index. A retired
-- promoted drill still occupies its reference: restoring it is the gym's
-- decision, and a second promotion of the same reference while the first is
-- merely retired would produce two operational identities for one reference
-- drill, which is what this index exists to prevent.
--
-- PROMOTION PINS A VERSION. pilot.drill_library rows are per-version -- its
-- primary key is (organization_id, drill_id) and pilot_drill_library_one_active_name
-- is partial on `active` -- so pointing at a drill_id pins the exact version
-- that was promoted. Reference supersession therefore cannot silently change an
-- operational drill: a newer reference version is a different row, and adopting
-- it is an explicit coach action. No trigger, no synchronization.
--
-- DEPENDS ON pilot.drills (drills migration, then drill-versioning) and
-- pilot.drill_library (drill-library-v3), all of which run earlier in the
-- workflow's `all` list. No begin;/commit; here, matching this repo's
-- runner-opens-the-transaction convention; the runner is
-- apps/web/scripts/pilot-apply-drill-reference-provenance-migration.mjs and it
-- asserts every guarantee above before it commits.

alter table pilot.drills
  add column if not exists reference_drill_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_drills_reference_drill_fk'
      and conrelid = 'pilot.drills'::regclass
  ) then
    alter table pilot.drills
      add constraint pilot_drills_reference_drill_fk
      foreign key (organization_id, reference_drill_id)
      references pilot.drill_library(organization_id, drill_id);
  end if;
end
$$;

create unique index if not exists pilot_drills_one_reference_per_org
  on pilot.drills(organization_id, reference_drill_id)
  where reference_drill_id is not null;

comment on column pilot.drills.reference_drill_id is
  'The pilot.drill_library drill this operational drill was promoted from, per OD-2026-09-16-001. NULL for a drill the gym authored itself. Pins the exact reference VERSION promoted: reference supersession never changes this row, and adopting a newer version is an explicit coach action. The reference row stays canonical for instructional and safety content and is never written from the operational side.';
