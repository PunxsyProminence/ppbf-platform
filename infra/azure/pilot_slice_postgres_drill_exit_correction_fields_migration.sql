-- Drill library: exit_condition and correction_path, carried from the frozen Backbone (lane NW-b).
--
-- WHY. The frozen Backbone's drill records have two fields the drill library had no column for,
-- exit_condition and correction_path (the drill-library exporter listed both in NO_COLUMN).
-- Without a column the app could not carry them or say they are missing. PK-197 A (docs/backbone/HANDOFF_NOTE.md): "Show the two fields as not
-- written, never as empty or complete." In the frozen set 17 of 387 drills have an exit condition
-- and 7 a correction path; the rest show "Not written yet".
--
-- WHAT CHANGES. Two columns on pilot.drill_library, the same shape as corrections and transfer
-- (pilot_slice_postgres_drill_library_v3_migration.sql:104-105): text not null default ''. Every
-- existing row reads '' and shows "Not written yet". No check and no length cap, as for the other
-- text fields (the in-app edit path caps text at 4000, drillLibraryEdit.ts MAX_LONG_TEXT).
--
-- No row's content changes. The content-import engine hashes '' and NULL alike
-- (contentImport/canonical.ts), so a drill whose package leaves both blank hashes as before; a
-- drill the seed gives a value becomes its next version on the next load (OD-2026-11-15-011
-- ruling 3: content is not edited in place).
--
-- Requires pilot.drill_library (pilot_slice_postgres_drill_library_v3_migration.sql); the `all`
-- chain runs it first.
--
-- Idempotent: add column if not exists. No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-drill-exit-correction-fields-migration.mjs) opens the transaction.

do $$
begin
  if to_regclass('pilot.drill_library') is null then
    raise exception 'DRILL_EXIT_CORRECTION_FIELDS_NOT_READY: pilot.drill_library does not exist -- apply the drill-library-v3 migration first';
  end if;
end
$$;

alter table pilot.drill_library
  add column if not exists exit_condition text not null default '';

alter table pilot.drill_library
  add column if not exists correction_path text not null default '';

comment on column pilot.drill_library.exit_condition is
  'The exit condition of the drill as the frozen Backbone writes it (lane NW-b). Empty = not written yet (PK-197 A).';
comment on column pilot.drill_library.correction_path is
  'The correction path of the drill as the frozen Backbone writes it (lane NW-b). Empty = not written yet (PK-197 A).';
