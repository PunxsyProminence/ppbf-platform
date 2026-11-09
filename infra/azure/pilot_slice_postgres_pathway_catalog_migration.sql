-- PATHWAY CATALOG: the backbone's stage catalog, its stage links and its stage
-- defaults (backbone crossover route A, lane BB-1b; SCHEMA_PROPOSAL P1, P2, the
-- catalog half of P7, SP-1; OD-2026-11-08-001).
--
-- ADDITIVE. Three new tables, and ONE change to an existing one: the stage-key
-- CHECK lane BB-1a put on pilot.content_stage_links
-- (pilot_content_stage_links_stage_check, content_labels migration) is
-- replaced by a foreign key to pilot.pathway_stages, so the catalog is the one
-- source of which stages exist. Every existing row is kept (see (4)).
-- athlete_pathway_stages, adultPathwayStages.ts and every athlete table are
-- untouched (P3, P10, P11 are later lanes); athlete_default_overrides (the
-- second half of P7) is a later lane.
--
-- WHAT THE CATALOG IS FOR. It describes the pathway and informs coaches.
-- Nothing reads it to compute or change a stage, and nothing in it restricts
-- where a coach places a member (SCHEMA_PROPOSAL principle 2; P2 "they do not
-- restrict where a coach places anyone"). No row here is a gate.
--
-- ORGANIZATION-SCOPED (principle 4, R-ID-6): every row carries
-- organization_id; the content-import engine seeds them for the organization
-- an organization admin loads into.
--
-- LABELS, NATIVELY (SP-1). Each table carries field_labels jsonb (per field:
-- {status, sources}) and evidence jsonb (the backbone's evidence entry or
-- list of entries, each with its own evidence_category and evidence_label),
-- written from the package's label columns. A default also carries its
-- record-level status and sources.
--
-- HISTORY. A changed row is updated in place and recorded as a new version in
-- pilot.reference_content_revisions (the keyed-registry pattern,
-- content_import migration (4)). A row a later snapshot no longer carries is
-- RETIRED (active_flag false) and kept; rows are never deleted -- refused by
-- trigger here, except the owning organization's own cascade.
--
-- No begin;/commit; here, matching this repo's runner-opens-the-transaction
-- convention; the runner is apps/web/scripts/pilot-apply-pathway-catalog-migration.mjs
-- and it asserts every guarantee above before it commits. Idempotent.

do $$
begin
  if to_regclass('pilot.organizations') is null then
    raise exception 'PATHWAY_CATALOG_NOT_READY: pilot.organizations does not exist -- apply the multi-organization migration first';
  end if;
  if to_regclass('pilot.content_stage_links') is null then
    raise exception 'PATHWAY_CATALOG_NOT_READY: pilot.content_stage_links does not exist -- apply the content-labels migration first';
  end if;
end;
$$;

-- (1) P1 ------------------------------------------------------------------------
-- stage_key keeps its human form (R-ID-7): letters then digits, e.g. Y3, AM1.
create table if not exists pilot.pathway_stages (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  stage_key              text not null,
  segment                text not null,
  ordinal                integer not null,
  name                   text not null,
  who_text               text,
  develops_text          text,
  typical_duration_text  text,
  contact_default        text not null,
  competition_text       text,
  age_band_guide_text    text,
  ppbf_name              text,
  ppbf_name_meaning      text,
  ppbf_name_language     text,
  field_labels           jsonb,
  evidence               jsonb,
  backbone_version       text,
  active_flag            boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint pilot_pathway_stages_pkey primary key (organization_id, stage_key),
  constraint pilot_pathway_stages_key_check check (stage_key ~ '^[A-Z]+[0-9]+$'),
  constraint pilot_pathway_stages_segment_check
    check (segment in ('youth', 'trunk', 'amateur', 'pro', 'recreational', 'exit')),
  constraint pilot_pathway_stages_ordinal_check check (ordinal > 0),
  constraint pilot_pathway_stages_name_check check (length(btrim(name, E' \t\n\r')) > 0),
  constraint pilot_pathway_stages_contact_default_check
    check (contact_default in ('none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring')),
  constraint pilot_pathway_stages_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_pathway_stages_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.pathway_stages is
  'Backbone pathway stage catalog (SCHEMA_PROPOSAL P1), per organization. Describes the pathway; nothing reads it to compute, change or restrict a member''s stage. A stage a later snapshot leaves out is retired (active_flag false), never deleted; versions are kept in reference_content_revisions (dataset pathway_stages).';

-- (2) P2 ------------------------------------------------------------------------
-- Both ends name a stage of the same organization. NO ACTION, not cascade, on
-- the stage keys: a stage is never deleted while a link names it; the
-- organization's own deletion removes both through organization_id.
create table if not exists pilot.pathway_stage_links (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  from_stage_key    text not null,
  to_stage_key      text not null,
  link_kind         text not null,
  field_labels      jsonb,
  evidence          jsonb,
  backbone_version  text,
  active_flag       boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pilot_pathway_stage_links_pkey primary key (organization_id, from_stage_key, to_stage_key),
  constraint pilot_pathway_stage_links_from_fkey
    foreign key (organization_id, from_stage_key) references pilot.pathway_stages(organization_id, stage_key),
  constraint pilot_pathway_stage_links_to_fkey
    foreign key (organization_id, to_stage_key) references pilot.pathway_stages(organization_id, stage_key),
  constraint pilot_pathway_stage_links_ends_check check (from_stage_key <> to_stage_key),
  constraint pilot_pathway_stage_links_kind_check
    check (link_kind in ('progression', 'branch', 'lateral', 'exit')),
  constraint pilot_pathway_stage_links_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_pathway_stage_links_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.pathway_stage_links is
  'Backbone next-stage links (SCHEMA_PROPOSAL P2), per organization. Links describe the map; they never restrict where a coach places anyone. Retired, never deleted; versions in reference_content_revisions (dataset pathway_stage_links).';

-- (3) P7, the catalog half ----------------------------------------------------------
-- default_id is the backbone's own id ('dft_' + hex14 of scope + ':' +
-- default_key, DATA_MODEL s3.2), kept as given and never re-minted. scope is a
-- stage key or a lane ('lane:non_contact'); stage_key is the scope when it
-- names a stage, so the stage end is a foreign key like a link's.
-- value_min / value_max / window_days / unit / sparring_type carry the
-- backbone's numeric defaults (D4: rounds per 7 days per sparring type);
-- value_text / value_vocabulary its worded ones; phases the per-phase values
-- of a default that changes within a stage.
create table if not exists pilot.pathway_stage_defaults (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  default_id        text not null,
  scope             text not null,
  stage_key         text generated always as (case when scope like 'lane:%' then null else scope end) stored,
  default_key       text not null,
  kind              text not null,
  value_text        text,
  value_vocabulary  text,
  value_min         numeric,
  value_max         numeric,
  unit              text,
  window_days       integer,
  sparring_type     text,
  composite_parent  text,
  phases            jsonb,
  display_text      text,
  status            text not null,
  sources           text[],
  field_labels      jsonb,
  evidence          jsonb,
  backbone_version  text,
  active_flag       boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pilot_pathway_stage_defaults_pkey primary key (organization_id, default_id),
  constraint pilot_pathway_stage_defaults_scope_key unique (organization_id, scope, default_key),
  constraint pilot_pathway_stage_defaults_stage_fkey
    foreign key (organization_id, stage_key) references pilot.pathway_stages(organization_id, stage_key),
  constraint pilot_pathway_stage_defaults_id_check check (default_id ~ '^dft_[0-9a-f]{14}$'),
  constraint pilot_pathway_stage_defaults_scope_check
    check (scope in ('lane:non_contact') or scope ~ '^[A-Z]+[0-9]+$'),
  constraint pilot_pathway_stage_defaults_default_key_check
    check (length(btrim(default_key, E' \t\n\r')) > 0),
  constraint pilot_pathway_stage_defaults_kind_check
    check (kind in ('default_rule', 'owner_rule', 'rule_reference', 'reference', 'information')),
  constraint pilot_pathway_stage_defaults_status_check
    check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_pathway_stage_defaults_range_check
    check (value_min is null or value_max is null or value_min <= value_max),
  constraint pilot_pathway_stage_defaults_window_check check (window_days is null or window_days > 0),
  constraint pilot_pathway_stage_defaults_phases_check
    check (phases is null or jsonb_typeof(phases) = 'array'),
  constraint pilot_pathway_stage_defaults_field_labels_check
    check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_pathway_stage_defaults_evidence_check
    check (evidence is null or jsonb_typeof(evidence) in ('object', 'array'))
);

comment on table pilot.pathway_stage_defaults is
  'Backbone stage defaults catalog (SCHEMA_PROPOSAL P7, catalog half), per organization: what a stage or lane starts from, each with its evidence and status. A default informs; a coach, parent or leadership member may override it (athlete_default_overrides, a later lane). Retired, never deleted; versions in reference_content_revisions (dataset pathway_stage_defaults).';

-- NEVER DELETED. The one delete allowed is the owning organization's own
-- cascade (the organization row is already gone when the cascade arrives), the
-- pattern of content_record_labels. Retiring is an UPDATE of active_flag.
create or replace function pilot.pathway_catalog_no_delete()
returns trigger
language plpgsql
as $pilot_pathway_catalog_no_delete$
begin
  if not exists (select 1 from pilot.organizations where organization_id = old.organization_id) then
    return old;
  end if;
  raise exception 'PATHWAY_CATALOG_ROW_KEPT: retire a catalog row (active_flag false); never delete it'
    using errcode = 'restrict_violation';
end;
$pilot_pathway_catalog_no_delete$;

drop trigger if exists pilot_pathway_stages_no_delete on pilot.pathway_stages;
create trigger pilot_pathway_stages_no_delete
  before delete on pilot.pathway_stages
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_pathway_stage_links_no_delete on pilot.pathway_stage_links;
create trigger pilot_pathway_stage_links_no_delete
  before delete on pilot.pathway_stage_links
  for each row execute function pilot.pathway_catalog_no_delete();

drop trigger if exists pilot_pathway_stage_defaults_no_delete on pilot.pathway_stage_defaults;
create trigger pilot_pathway_stage_defaults_no_delete
  before delete on pilot.pathway_stage_defaults
  for each row execute function pilot.pathway_catalog_no_delete();

-- (4) content_stage_links: the stage key now references the catalog -----------------
-- Lane BB-1a's named CHECK goes; a foreign key takes its place. The key is
-- added NOT VALID, so every existing row is kept whatever it names, and every
-- new or changed row is checked. It is VALIDATED in the same run once every
-- existing row names a catalog stage -- on a database with no labelled
-- content yet, straight away; otherwise on the first re-run after the catalog
-- is loaded (this file is idempotent and the `all` list re-runs it).
alter table pilot.content_stage_links drop constraint if exists pilot_content_stage_links_stage_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_content_stage_links_stage_fkey'
       and conrelid = 'pilot.content_stage_links'::regclass
  ) then
    alter table pilot.content_stage_links
      add constraint pilot_content_stage_links_stage_fkey
      foreign key (organization_id, stage_key) references pilot.pathway_stages(organization_id, stage_key)
      not valid;
  end if;

  if exists (
    select 1 from pg_constraint
     where conname = 'pilot_content_stage_links_stage_fkey'
       and conrelid = 'pilot.content_stage_links'::regclass
       and not convalidated
  ) and not exists (
    select 1 from pilot.content_stage_links l
     where not exists (
       select 1 from pilot.pathway_stages s
        where s.organization_id = l.organization_id and s.stage_key = l.stage_key
     )
  ) then
    alter table pilot.content_stage_links validate constraint pilot_content_stage_links_stage_fkey;
  end if;
end;
$$;
