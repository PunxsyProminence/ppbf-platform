-- Research Archive originals: which PDF a Library source was filed as in the
-- nonprofit SharePoint Research Archive, and which of those PDFs an excerpt
-- was taken from (issue #345; lane L57, PR A of 3).
--
-- Owner decisions:
--   * OD-2026-10-02-015 D5: wiring research originals into the SharePoint
--     Research Archive is its own item and needs a database change. This is
--     that change. Nothing here writes to SharePoint.
--   * OD-2026-10-02-013 answer 4A: whole PDFs stay in the SharePoint Research
--     Archive; the app keeps only curator-chosen excerpts. This table holds
--     the archive's IDENTITY of a PDF (where it is, what its bytes hash to,
--     how PPBF got it), never the PDF or its text.
--
-- WHY A TABLE AND NOT COLUMNS ON THE DOCUMENT. One PDF yields many excerpts,
-- and each excerpt is its own shadow_library_documents row. The document
-- table's unique (organization_id, content_sha256) would refuse the second
-- excerpt of the same PDF if the PDF's hash sat on the document. So the PDF
-- gets one row here, and each excerpt points at it.
--
--   shadow_library_sources (the work)
--     1 --- * shadow_library_archived_originals (one row per filed PDF byte-version)
--               1 --- * shadow_library_documents (one excerpt; archived_original_id)
--
-- WHAT THE CONSTRAINTS HOLD:
--   * one row per PDF per shelf: unique (organization_id, content_sha256). The
--     same PDF on the gym shelf and the platform shelf is one SharePoint file
--     and two rows, hence unique (organization_id, drive_id, item_id) rather
--     than (drive_id, item_id);
--   * an original belongs to a source on its own shelf, and an excerpt may
--     only point at an original of ITS source on ITS shelf: both are composite
--     foreign keys, so moving an excerpt to another source while it is linked
--     is refused too. A null link is no link (MATCH SIMPLE), which is every
--     existing document and every excerpt typed rather than read from a PDF;
--   * filed only under a subject folder, R01-R19. R00 (Unsorted Drop) and R98
--     (Duplicate Hold) are archive workflow states, not subjects (#345);
--   * a later version (a corrected version of record, say) names the one it
--     supersedes, of the same source on the same shelf, and never itself;
--   * nothing is removed while something points at it (on delete restrict):
--     the original in SharePoint is the durable artefact, and a row that
--     vanished would leave it unaccounted for;
--   * a document about an athlete (subject_id set) is never linked to an
--     archive original: the Research Archive holds research, and the
--     retention purge removes an athlete's documents but not this table's
--     rows, so a link would let a record of a child outlive the purge.
--
-- version_kind follows NISO's Journal Article Versions terms (RP-8-2008),
-- reduced to the ones a curator can tell apart from the PDF in hand.
--
-- ADDITIVE AND IDEMPOTENT. Requires the base schema and the shadow-evidence
-- migration (its unique index on shadow_library_sources (source_id,
-- organization_id) is what the source key references). No existing row is
-- changed. The runner opens the transaction, so this file carries none
-- (apps/web/scripts/pilot-apply-research-archive-originals-migration.mjs).

create table if not exists pilot.shadow_library_archived_originals (
  archived_original_id text not null,
  organization_id text not null references pilot.organizations(organization_id),
  source_id text not null,
  provider text not null default 'sharepoint',
  site_id text not null,
  drive_id text not null,
  item_id text not null,
  -- Where the governed copy lives. Never the publisher or DOI address.
  web_url text null,
  archive_root_item_id text not null,
  archive_domain_code text not null,
  -- The name it was filed under, and the name the curator's file had.
  archive_filename text not null,
  original_filename text not null,
  content_sha256 text not null,
  byte_size bigint not null,
  acquisition_provider text not null,
  acquisition_channel text not null,
  acquired_at timestamptz not null,
  version_kind text not null default 'unknown',
  supersedes_archived_original_id text null,
  created_by_account_id text not null,
  created_by_role text not null,
  created_at timestamptz not null default now(),
  constraint pilot_shadow_library_archived_originals_pkey primary key (archived_original_id),
  constraint pilot_shadow_library_archived_originals_source_fk
    foreign key (source_id, organization_id)
    references pilot.shadow_library_sources(source_id, organization_id)
    on delete restrict,
  constraint pilot_shadow_library_archived_originals_org_sha_key
    unique (organization_id, content_sha256),
  constraint pilot_shadow_library_archived_originals_org_item_key
    unique (organization_id, drive_id, item_id),
  -- The target of both composite keys below.
  constraint pilot_shadow_library_archived_originals_link_key
    unique (archived_original_id, source_id, organization_id),
  constraint pilot_shadow_library_archived_originals_supersedes_fk
    foreign key (supersedes_archived_original_id, source_id, organization_id)
    references pilot.shadow_library_archived_originals(archived_original_id, source_id, organization_id)
    on delete restrict,
  constraint pilot_shadow_library_archived_originals_not_self_check
    check (supersedes_archived_original_id is null or supersedes_archived_original_id <> archived_original_id),
  constraint pilot_shadow_library_archived_originals_provider_check
    check (provider = 'sharepoint'),
  constraint pilot_shadow_library_archived_originals_ids_check
    check (btrim(site_id) <> '' and btrim(drive_id) <> '' and btrim(item_id) <> '' and btrim(archive_root_item_id) <> ''),
  constraint pilot_shadow_library_archived_originals_url_check
    check (web_url is null or web_url ~ '^https://'),
  constraint pilot_shadow_library_archived_originals_domain_check
    check (archive_domain_code ~ '^R(0[1-9]|1[0-9])$'),
  -- The same allowlist researchArchiveWrite.ts applies before any request.
  constraint pilot_shadow_library_archived_originals_filename_check
    check (archive_filename ~* '^[a-z0-9][a-z0-9._ -]{0,200}[.]pdf$'),
  constraint pilot_shadow_library_archived_originals_original_name_check
    check (length(btrim(original_filename)) between 1 and 255),
  constraint pilot_shadow_library_archived_originals_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pilot_shadow_library_archived_originals_byte_size_check
    check (byte_size > 0),
  constraint pilot_shadow_library_archived_originals_acq_provider_check
    check (length(btrim(acquisition_provider)) between 1 and 200),
  constraint pilot_shadow_library_archived_originals_channel_check
    check (acquisition_channel in ('library_database', 'publisher_site', 'open_access_repository', 'author_copy', 'ppbf_created', 'other')),
  constraint pilot_shadow_library_archived_originals_version_kind_check
    check (version_kind in ('author_original', 'accepted_manuscript', 'version_of_record', 'corrected_version_of_record', 'other', 'unknown')),
  constraint pilot_shadow_library_archived_originals_created_by_check
    check (btrim(created_by_account_id) <> '' and btrim(created_by_role) <> '')
);

create index if not exists idx_shadow_library_archived_originals_source
  on pilot.shadow_library_archived_originals(organization_id, source_id);

alter table pilot.shadow_library_documents
  add column if not exists archived_original_id text null;

do $pilot_documents_archived_original_fk$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_library_documents_archived_original_fk'
      and conrelid = to_regclass('pilot.shadow_library_documents')
  ) then
    alter table pilot.shadow_library_documents
      add constraint pilot_shadow_library_documents_archived_original_fk
      foreign key (archived_original_id, source_id, organization_id)
      references pilot.shadow_library_archived_originals(archived_original_id, source_id, organization_id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_library_documents_archived_original_subject_check'
      and conrelid = to_regclass('pilot.shadow_library_documents')
  ) then
    alter table pilot.shadow_library_documents
      add constraint pilot_shadow_library_documents_archived_original_subject_check
      check (archived_original_id is null or subject_id is null);
  end if;
end
$pilot_documents_archived_original_fk$;

create index if not exists idx_shadow_library_documents_archived_original
  on pilot.shadow_library_documents(archived_original_id)
  where archived_original_id is not null;
