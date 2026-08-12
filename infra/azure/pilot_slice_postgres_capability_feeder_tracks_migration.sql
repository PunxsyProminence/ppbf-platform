-- Capability feeder tracks: persists the link between a capability and the
-- evidence tracks that feed it.
--
-- WHY THIS EXISTS
--
-- The open question the owner asked to have answered was how SHADOW evidence is
-- "tied to type/role" -- which capability a given piece of evidence actually
-- supports. Neither the organization id nor the library scope column does that,
-- and the handoff recorded it as needing its own axis.
--
-- It turned out the corpus already carries the axis, and nothing needed
-- designing:
--
--   * All 1,193 chunks in seed-data/shadow-research/2026-08-07 carry a track in
--     `metadata->>'track'` -- 14 of them, A1-A8 and B1-B6, with none missing.
--     The 14 library documents are those same 14 tracks, one document each.
--   * All 30 capability_map rows declare the tracks that feed them, in a
--     pipe-delimited `_feeder_tracks` column ('A3|A6'), and between them they
--     span all 14 tracks. Coverage per capability is already computed there:
--     19 covered, 10 partial, 1 uncovered.
--
-- The break was in the importer, not the model: it drops every `_`-prefixed
-- CSV column, so `_feeder_tracks` never reached the database. Chunk metadata
-- (which holds the track) was imported all along. So this migration adds the one
-- column that closes the loop, and from then on
-- "which capabilities does the platform have evidence for" is a join rather
-- than an open design question.
--
-- Idempotent and safe to re-apply.
--
-- No outer `do $$ ... $$` wrapper, for the reason recorded in
-- pilot_slice_postgres_data_retention_deletion_migration.sql: a wrapper around
-- already-idempotent statements buys nothing and has broken a deployment here
-- before. The runner wraps the file in one transaction.

-- --- The capability side of the link ---
--
-- text[] rather than a delimited string: `A3|A6` is two tracks, and every read
-- of it wants them separately. NOT NULL with an empty default so a capability
-- with no declared feeder reads as "feeds from nothing", which is a fact, rather
-- than as NULL, which a coverage query would have to special-case.
alter table pilot.shadow_library_capability_map
  add column if not exists feeder_tracks text[] not null default '{}'::text[];

comment on column pilot.shadow_library_capability_map.feeder_tracks is
  'Evidence tracks feeding this capability (A1-A8, B1-B6), from the corpus''s '
  '_feeder_tracks column. Joins to shadow_library_chunks.metadata->>''track''. '
  'The authoritative parse lives in scripts/import-shadow-research.mjs.';

-- --- The chunk side of the link ---
--
-- The join above reads chunks by track within an organization, and the track
-- lives inside jsonb, so without this index every coverage question is a
-- sequential scan of the chunk table. An expression index rather than a
-- generated column: the track is already in metadata, and a second copy of it
-- would be one more thing that can disagree with itself.
create index if not exists idx_shadow_library_chunks_org_track
  on pilot.shadow_library_chunks (organization_id, (metadata->>'track'));
