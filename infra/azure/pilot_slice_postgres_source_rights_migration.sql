-- Library source rights: a rights marker on every source, and a rule for when
-- the Library may hold a source's full text.
--
-- Owner decisions:
--   * OD-2026-10-03-002 section 3: a source carries one of ppbf_owned /
--     open_licence / licensed_excerpt_only / unknown, and unknown refuses full
--     text.
--   * OD-2026-10-02-013 answer 4A: the app keeps only excerpts a curator
--     chooses, with citation and page; full text only for PPBF-owned or
--     open-licence material.
--   * OD-2026-10-02-013 answer 2A: licensed excerpts live in the database only,
--     never in the public repository (nothing here writes text).
--
-- WHAT A CHUNK IS. A chunk is either full text or an excerpt. An excerpt names
-- where in the source it comes from (excerpt_locator: a page, section or
-- timestamp -- the same locator the /evidence intake already requires); its
-- citation is the source the chunk belongs to. Full text names no locator.
--
-- THE RULE, ENFORCED HERE so every writer is held to it -- the chunks route,
-- the research importer, and the operator workflow still to come:
--   * a full-text chunk is refused unless the source of its DOCUMENT is
--     ppbf_owned or open_licence. The document's source owns the text; a
--     chunk's own source_id may differ (the 2026-08-07 seed's chunks cite the
--     paper a synthesis is about, while the text is PPBF's synthesis, filed
--     under the programme source);
--   * a source's rights may not drop below full-text level while full-text
--     chunks sit under its documents;
--   * a document may not move to a source below full-text level while it
--     holds full-text chunks.
-- Each check locks the rows it reads (FOR SHARE) so two concurrent writes
-- cannot each pass and together break the rule. Lock order is document, then
-- source; the research importer takes source, then document, so a curator's
-- chunk write racing an import of the same document can deadlock, and
-- Postgres then aborts one side (a retryable error, never a broken rule).
--
-- CLASSIFICATION of what is already there:
--   * The 21 internal_policy sources of the 2026-08-07 seed are PPBF's own
--     material: 20 auto-extracted PPBF repo documents and the programme source
--     src_6563c68e39047128, whose 14 documents say "synthesis text authored by
--     the research program; NOT publisher full text". They, and the one copy
--     the importer's ppbf_policy scope and pilot-rescope-library-baseline.mjs
--     make of them (src_ppbfpol_6563c68e39047128, the programme source's
--     copy), become ppbf_owned. Matched by exact source id ONLY, never by
--     metadata: metadata is caller-supplied through the sources route, and
--     this file re-runs on every apply-migrations dispatch, so a curator's
--     source claiming metadata.copied_from_source_id = <a seed id> would
--     otherwise be raised to ppbf_owned on the next run. The route mints
--     source ids itself (source_<uuid>), so none of these ids is reachable
--     from it. apps/web/scripts/sourceRightsAllowlist.test.ts holds this list
--     to the importer's own.
--   * Every other source stays unknown. Nothing on file says any of them is
--     open-licence, and guessing is not classification; a reviewer changes a
--     source's marker in the app.
--   * Existing chunks written by the /evidence text intake carry a curator
--     locator in metadata.locator; they become excerpts with that locator.
--     Every other existing chunk reads full_text. No existing row is refused:
--     the rule checks writes, and the runner prints how many full-text chunks
--     sit under sources below full-text level.
--
-- ADDITIVE AND IDEMPOTENT. Requires the base schema. The runner opens the
-- transaction, so this file carries none
-- (apps/web/scripts/pilot-apply-source-rights-migration.mjs).

alter table pilot.shadow_library_sources
  add column if not exists rights_status text not null default 'unknown';

do $pilot_source_rights_status_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_library_sources_rights_status_check'
      and conrelid = to_regclass('pilot.shadow_library_sources')
  ) then
    alter table pilot.shadow_library_sources
      add constraint pilot_shadow_library_sources_rights_status_check
      check (rights_status in ('ppbf_owned', 'open_licence', 'licensed_excerpt_only', 'unknown'));
  end if;
end
$pilot_source_rights_status_check$;

alter table pilot.shadow_library_chunks
  add column if not exists text_kind text not null default 'full_text';

alter table pilot.shadow_library_chunks
  add column if not exists excerpt_locator text null;

-- Existing intake excerpts: classified before the shape check is added, so the
-- check is validated against rows that already satisfy it.
update pilot.shadow_library_chunks
   set text_kind = 'excerpt',
       excerpt_locator = btrim(metadata->>'locator')
 where text_kind = 'full_text'
   and excerpt_locator is null
   and btrim(coalesce(metadata->>'locator', '')) <> '';

do $pilot_chunk_text_kind_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_library_chunks_text_kind_check'
      and conrelid = to_regclass('pilot.shadow_library_chunks')
  ) then
    alter table pilot.shadow_library_chunks
      add constraint pilot_shadow_library_chunks_text_kind_check
      check (
        (text_kind = 'full_text' and excerpt_locator is null)
        or (text_kind = 'excerpt' and btrim(coalesce(excerpt_locator, '')) <> '')
      );
  end if;
end
$pilot_chunk_text_kind_check$;

-- The 21 internal_policy sources of the 2026-08-07 seed, and the importer's
-- copy of the programme source. Exact ids; no metadata is read (see above).
update pilot.shadow_library_sources s
   set rights_status = 'ppbf_owned'
  from (select '{src_b7041e76b524f743,src_1224589a057d11b1,src_ae9e74a246508870,src_ee346c4c03fbbaaf,src_6348f5240f9c2b9e,src_48097b8ac8a29aea,src_cb0941607cf6e855,src_bea776a3493dd897,src_42bf1537a1f93ab2,src_d596d833bbdd0e67,src_9ceadf7c40f908be,src_01289d452b4a6971,src_c4a73634d556a46d,src_10538696f1d5ea88,src_94a20de4f88e7e3c,src_ba8fe9ece0b1f971,src_060860c8d3d424cd,src_ea1a2c9630801ac7,src_0f4cb2616bd6992f,src_a59b4035ad4c9fe6,src_6563c68e39047128,src_ppbfpol_6563c68e39047128}'::text[] as ids) seed
 where s.rights_status = 'unknown'
   and s.source_id = any(seed.ids);

-- A chunk's full text is allowed only under a ppbf_owned or open_licence
-- document source.
create or replace function pilot.shadow_library_chunk_rights_guard()
returns trigger
language plpgsql
as $fn$
declare
  v_source text;
  v_rights text;
begin
  -- A writer that predates the text_kind column but files a curator locator
  -- in metadata (the /evidence intake, live before this migration's app
  -- release) is writing an excerpt: store it as one, exactly as the backfill
  -- above does for existing rows. No release window refuses that intake.
  if new.text_kind = 'full_text' and new.excerpt_locator is null
     and btrim(coalesce(new.metadata->>'locator', '')) <> '' then
    new.text_kind := 'excerpt';
    new.excerpt_locator := btrim(new.metadata->>'locator');
  end if;
  if new.text_kind <> 'full_text' then
    return new;
  end if;
  -- Two single-table reads, each locked, in this order. One joined read is
  -- not enough: if the document is re-pointed while this waits for its lock,
  -- the re-checked join finds no source row and would read as "no document".
  select d.source_id into v_source
    from pilot.shadow_library_documents d
   where d.document_id = new.document_id
     for share;
  if not found then
    -- No document: the foreign key refuses the row with its own message.
    return new;
  end if;
  select s.rights_status into v_rights
    from pilot.shadow_library_sources s
   where s.source_id = v_source
     for share;
  if v_rights in ('ppbf_owned', 'open_licence') then
    return new;
  end if;
  raise exception 'SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED: the source is %, so the Library may hold only excerpts of it, each with a page, section or timestamp. Full text needs a ppbf_owned or open_licence source.', coalesce(v_rights, 'missing')
    using errcode = '23514';
end
$fn$;

drop trigger if exists shadow_library_chunk_rights_guard on pilot.shadow_library_chunks;
create trigger shadow_library_chunk_rights_guard
  before insert or update of document_id, text_kind, text_content
  on pilot.shadow_library_chunks
  for each row execute function pilot.shadow_library_chunk_rights_guard();

-- A source may not drop below full-text level while full text sits under it.
create or replace function pilot.shadow_library_source_rights_guard()
returns trigger
language plpgsql
as $fn$
begin
  if new.rights_status in ('ppbf_owned', 'open_licence')
     or old.rights_status not in ('ppbf_owned', 'open_licence') then
    return new;
  end if;
  if exists (
    select 1
      from pilot.shadow_library_documents d
      join pilot.shadow_library_chunks c on c.document_id = d.document_id
     where d.source_id = new.source_id
       and c.text_kind = 'full_text'
  ) then
    raise exception 'SHADOW_LIBRARY_RIGHTS_LOWERED_UNDER_FULL_TEXT: source % holds full text, so it cannot become %. Remove or replace that text with excerpts first.', new.source_id, new.rights_status
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

drop trigger if exists shadow_library_source_rights_guard on pilot.shadow_library_sources;
create trigger shadow_library_source_rights_guard
  before update of rights_status
  on pilot.shadow_library_sources
  for each row execute function pilot.shadow_library_source_rights_guard();

-- A document holding full text may not move under a source below full-text level.
create or replace function pilot.shadow_library_document_rights_guard()
returns trigger
language plpgsql
as $fn$
declare
  v_rights text;
begin
  if new.source_id is not distinct from old.source_id then
    return new;
  end if;
  if not exists (
    select 1 from pilot.shadow_library_chunks c
     where c.document_id = new.document_id and c.text_kind = 'full_text'
  ) then
    return new;
  end if;
  select rights_status into v_rights
    from pilot.shadow_library_sources
   where source_id = new.source_id
     for share;
  if v_rights is null or v_rights in ('ppbf_owned', 'open_licence') then
    return new;
  end if;
  raise exception 'SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED: document % holds full text and source % is %.', new.document_id, new.source_id, v_rights
    using errcode = '23514';
end
$fn$;

drop trigger if exists shadow_library_document_rights_guard on pilot.shadow_library_documents;
create trigger shadow_library_document_rights_guard
  before update of source_id
  on pilot.shadow_library_documents
  for each row execute function pilot.shadow_library_document_rights_guard();
