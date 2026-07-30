-- Semantic Library search: per-chunk embedding storage.
--
-- Additive and idempotent, like every migration in this directory. The
-- embedding is stored as a jsonb array of floats rather than a vector type on
-- purpose: pgvector is an extension the managed server has not enabled, and
-- at this library's scale (hundreds of chunks per organization) similarity is
-- ranked in the application over a bounded candidate set, so no index or
-- extension is required. embedding_model records which deployment produced
-- the vector, so a model change can invalidate and re-embed selectively.
--
-- Rows with a NULL embedding are simply not semantically searchable and fall
-- back to keyword search; nothing in the read path requires this migration to
-- have run, which is what makes it safe to apply ahead of the feature flag.
--
-- Apply through the controlled migration runner, never from an HTTP request.
begin;

alter table pilot.shadow_library_chunks
  add column if not exists embedding jsonb null,
  add column if not exists embedding_model text null;

commit;

