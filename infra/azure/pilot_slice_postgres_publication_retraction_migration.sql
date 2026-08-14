-- Publication retraction: a controlled non-distributable state for media
-- whose guardian consent was withdrawn after publication.
--
-- Owner decision, 2026-08-14. When a guardian withdraws media consent,
-- content already published must become immediately non-distributable --
-- without deleting the publication, consent, compliance, or audit history,
-- and without any automatic path back: republishing requires current
-- consent, a fresh compliance approval, and an explicit new publish.
--
-- WHY A NEW STATUS AND NEW COLUMNS RATHER THAN 'archived'/'archived_at':
-- the owner allowed reusing 'archived' only if provably non-distributable
-- on every reader. It is not, and it is not even reachable -- nothing in
-- the codebase writes status='archived' or either archived_at column, only
-- one of the two research_library readers filters archived_at, and no
-- publication reader excludes 'archived' at all (audited 2026-08-14).
-- 'archived' also names a different lifecycle (quiet end-of-life), and a
-- safeguarding retraction must not be indistinguishable from tidying up.
--
--   pilot.video_publications.status            + 'retracted'
--     Terminal for distribution. The only way forward is an explicit
--     org-admin reopen to 'pending_review' with the compliance check reset
--     to 'pending', after which the normal consent-gated approval and
--     consent-gated publish must both happen again.
--
--   pilot.research_library.suppressed_at / suppressed_by_account_id /
--   suppressed_reason
--     The shelf row is the distribution artifact, and it stays on the shelf
--     as history -- suppressed, attributed, and dated, never deleted. The
--     live read path filters on suppressed_at is null.
--
-- The status CHECK was written inline in the publications migration, so
-- Postgres auto-named it. Same doctrine as the drill-vocabulary-widening
-- migration: find every CHECK on the column through the catalog rather than
-- trusting a generated name, then add the replacement under an explicit
-- name. The whole block is guarded on the named constraint already
-- admitting 'retracted', so `all`-loop replays are catalog no-ops.
--
-- DEPENDS ON pilot_slice_postgres_publications_migration.sql; the `all`
-- loop orders this file after `publications`.
--
-- No `begin;`/`commit;`: the runner
-- (apps/web/scripts/pilot-apply-publication-retraction-migration.mjs) opens
-- the transaction itself, matching the parent-hub-placement runner.

do $$
declare
  existing record;
begin
  if to_regclass('pilot.video_publications') is null then
    raise exception 'PUBLICATION_RETRACTION_NOT_READY: pilot.video_publications does not exist -- apply the publications migration first';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_video_publications_status_check'
      and conrelid = 'pilot.video_publications'::regclass
      and pg_get_constraintdef(oid) like '%retracted%'
  ) then
    for existing in
      select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'pilot'
        and rel.relname = 'video_publications'
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) ilike '%status%'
        and pg_get_constraintdef(con.oid) not ilike '%compliance_check_status%'
        and pg_get_constraintdef(con.oid) not ilike '%publication_type%'
        and pg_get_constraintdef(con.oid) not ilike '%visibility%'
    loop
      execute format('alter table pilot.video_publications drop constraint %I', existing.conname);
    end loop;

    alter table pilot.video_publications
      add constraint pilot_video_publications_status_check
      check (status in ('draft', 'pending_review', 'approved', 'published', 'rejected', 'archived', 'retracted'));
  end if;
end $$;

comment on constraint pilot_video_publications_status_check on pilot.video_publications is
  'retracted is the safeguarding suppression state: consent was withdrawn (or an org admin retracted it) after publication. Terminal for distribution; the only way forward is an explicit reopen to pending_review followed by a fresh consent-gated approval and publish. Not a synonym for archived.';

alter table pilot.research_library
  add column if not exists suppressed_at timestamptz null,
  add column if not exists suppressed_by_account_id text null,
  add column if not exists suppressed_reason text null;

-- The live-shelf read: one organization's unsuppressed, unarchived rows,
-- newest first.
create index if not exists idx_research_library_live
  on pilot.research_library(organization_id, published_at desc)
  where suppressed_at is null and archived_at is null;
