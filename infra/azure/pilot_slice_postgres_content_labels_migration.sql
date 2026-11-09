-- CONTENT LABELS: where the backbone's label columns land (backbone crossover
-- route A, lane BB-1a; SCHEMA_PROPOSAL P9, P19, SP-1, SP-11, SP-15;
-- OD-2026-11-08-001).
--
-- A content package may carry three optional columns on every dataset's root
-- file (apps/web/src/server/pilot/contentImport/specs/common.ts labelColumns):
-- field_labels and evidence (JSON) and stage_keys (a | list). This migration
-- adds the two tables the content-import engines write them to. ADDITIVE ONLY:
-- no existing table is altered, and drill_library.field_provenance stays as it
-- is (SCHEMA_PROPOSAL principle 3).
--
-- (1) pilot.content_record_labels: the labels of ONE VERSION of one item
--     (target_kind + target_lineage_id + target_version). Written when an
--     import writes that version; never changed after (append-only by
--     trigger, the pattern of pilot.reference_content_revisions in
--     content_import_migration.sql). A version written without labels has no
--     row here.
--
-- (2) pilot.content_stage_links: which pathway stages an item serves, by
--     LINEAGE, so a new version keeps its links (backbone DATA_MODEL s6). A
--     link that a later import drops is ended (superseded_at), never deleted;
--     one current link per item and stage. A link describes the map: nothing
--     reads it to place a member or to limit what a coach runs.
--
-- stage_key is checked against the 18 stage keys of SCHEMA_PROPOSAL.md:47-71
-- by ONE named constraint, pilot_content_stage_links_stage_check, that nothing
-- else depends on (not the runner's readiness check either), so lane BB-1b can
-- replace it with a foreign key to the pathway stage catalog in one additive
-- step. role and lane are plain nullable text with no list here: a package
-- carries stage keys only, so the engine writes both NULL, and the role list
-- is not settled in one source yet (Overwatch, PR #1893).
--
-- target_kind is a lowercase slug naming the app's item kind (drill,
-- workout_template, ...); target_lineage_id is the item's lineage key as the
-- package names it. No foreign key to the item tables: seven kinds live in
-- seven tables, and the registries have no lineage column.
--
-- No begin;/commit; here, matching this repo's runner-opens-the-transaction
-- convention; the runner is apps/web/scripts/pilot-apply-content-labels-migration.mjs
-- and it asserts every guarantee above before it commits. Idempotent.

do $$
begin
  if to_regclass('pilot.organizations') is null then
    raise exception 'CONTENT_LABELS_NOT_READY: pilot.organizations does not exist -- apply the multi-organization migration first';
  end if;
end;
$$;

-- (1) --------------------------------------------------------------------------
create table if not exists pilot.content_record_labels (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  target_kind            text not null,
  target_lineage_id      text not null,
  target_version         integer not null,
  field_labels           jsonb,
  evidence               jsonb,
  backbone_version       text,
  import_id              text not null,
  recorded_by_account_id text not null,
  recorded_by_role       text not null,
  recorded_at            timestamptz not null default now(),
  constraint pilot_content_record_labels_pkey
    primary key (organization_id, target_kind, target_lineage_id, target_version),
  constraint pilot_content_record_labels_kind_check
    check (target_kind ~ '^[a-z][a-z0-9_]*$'),
  constraint pilot_content_record_labels_lineage_check
    check (length(btrim(target_lineage_id, E' \t\n\r')) > 0),
  constraint pilot_content_record_labels_version_check check (target_version > 0),
  constraint pilot_content_record_labels_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_content_record_labels_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array')),
  constraint pilot_content_record_labels_something_check
    check (field_labels is not null or evidence is not null),
  constraint pilot_content_record_labels_import_id_check
    check (length(btrim(import_id, E' \t\n\r')) > 0)
);

-- APPEND-ONLY BY TRIGGER, as reference_content_revisions: the labels of a
-- version are history. The one delete allowed is the owning organization's
-- own cascade (the parent row is already gone when the cascade arrives).
create or replace function pilot.content_record_labels_append_only()
returns trigger
language plpgsql
as $pilot_content_record_labels_append_only$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from pilot.organizations where organization_id = old.organization_id
  ) then
    return old;
  end if;
  raise exception 'CONTENT_RECORD_LABELS_IMMUTABLE'
    using errcode = 'restrict_violation';
end;
$pilot_content_record_labels_append_only$;

drop trigger if exists pilot_content_record_labels_append_only on pilot.content_record_labels;
create trigger pilot_content_record_labels_append_only
  before update or delete on pilot.content_record_labels
  for each row
  execute function pilot.content_record_labels_append_only();

comment on table pilot.content_record_labels is
  'Backbone labels of one version of one content item (SCHEMA_PROPOSAL P19, SP-1): field_labels = per-field status (OBSERVED, REPORTED, INFERRED, UNVERIFIED) and sources; evidence = the evidence entry or entries (category, label, check state, ids, basis). Written by content import with the version it labels. UPDATE and DELETE are refused by trigger; only the owning organization''s deletion removes rows.';

-- (2) --------------------------------------------------------------------------
create table if not exists pilot.content_stage_links (
  link_id                  bigint generated always as identity primary key,
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  target_kind              text not null,
  target_lineage_id        text not null,
  stage_key                text not null,
  role                     text,
  lane                     text,
  import_id                text not null,
  recorded_by_account_id   text not null,
  recorded_by_role         text not null,
  recorded_at              timestamptz not null default now(),
  superseded_at            timestamptz,
  superseded_by_import_id  text,
  constraint pilot_content_stage_links_kind_check
    check (target_kind ~ '^[a-z][a-z0-9_]*$'),
  constraint pilot_content_stage_links_lineage_check
    check (length(btrim(target_lineage_id, E' \t\n\r')) > 0),
  constraint pilot_content_stage_links_stage_check
    check (stage_key in ('Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'T1', 'T2', 'AM1', 'AM2', 'AM3', 'PR1', 'PR2', 'PR3', 'PR4', 'PR5', 'RC1', 'FT1', 'EX1')),
  constraint pilot_content_stage_links_lane_check
    check (lane is null or length(btrim(lane, E' \t\n\r')) > 0),
  constraint pilot_content_stage_links_import_id_check
    check (length(btrim(import_id, E' \t\n\r')) > 0),
  constraint pilot_content_stage_links_ended_check
    check ((superseded_at is null) = (superseded_by_import_id is null))
);

create unique index if not exists idx_content_stage_links_current
  on pilot.content_stage_links (organization_id, target_kind, target_lineage_id, stage_key)
  where superseded_at is null;

-- A link is history once written: the only change allowed is ending a current
-- link (superseded_at and superseded_by_import_id set together, once). The one
-- delete allowed is the owning organization's own cascade.
create or replace function pilot.content_stage_links_guard()
returns trigger
language plpgsql
as $pilot_content_stage_links_guard$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from pilot.organizations where organization_id = old.organization_id) then
      return old;
    end if;
    raise exception 'CONTENT_STAGE_LINK_IMMUTABLE' using errcode = 'restrict_violation';
  end if;
  if old.superseded_at is null
     and new.superseded_at is not null
     and (to_jsonb(new) - 'superseded_at' - 'superseded_by_import_id')
       = (to_jsonb(old) - 'superseded_at' - 'superseded_by_import_id') then
    return new;
  end if;
  raise exception 'CONTENT_STAGE_LINK_IMMUTABLE' using errcode = 'restrict_violation';
end;
$pilot_content_stage_links_guard$;

drop trigger if exists pilot_content_stage_links_guard on pilot.content_stage_links;
create trigger pilot_content_stage_links_guard
  before update or delete on pilot.content_stage_links
  for each row
  execute function pilot.content_stage_links_guard();

comment on table pilot.content_stage_links is
  'Pathway stages a content item serves, by lineage (SCHEMA_PROPOSAL P9, SP-15). A dropped link is ended (superseded_at), never deleted; one current link per item and stage. Links describe the map; they never restrict where a coach places a member or what a coach runs.';
