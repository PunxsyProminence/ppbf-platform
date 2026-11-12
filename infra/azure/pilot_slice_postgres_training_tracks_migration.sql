-- TRAINING TRACKS: a multi-week class track, its ordered blocks and the
-- sessions each block lists by week and day (backbone crossover lane FT1a;
-- SCHEMA_PROPOSAL P17, SP-9; DATA_MODEL s4-5). First use: the 8-week FT1
-- non-contact class track (OD-2026-11-11-003).
--
-- ADDITIVE. Three new tables. No existing table, row or constraint changes.
-- athlete_development_blocks.source_track_block_id (P17's per-athlete half) is
-- NOT here: it comes with the lane that starts an athlete on a track, since
-- nothing would write it yet. Enrollment groups stay in pilot.programs.
--
-- A TEMPLATE, NOT A PLAN FOR ANYONE. No athlete id, no dates, no completion
-- state. A track is gym-wide coaching content read by the organization's
-- coaches; nothing reads it to compute or restrict what a member does.
--
-- ONE UNIT, VERSIONED (R2). A track, its blocks and its block sessions are one
-- unit, loaded by the content-import engine (datasets/trainingTracks.ts) the
-- way a workout template and its items are: a change anywhere writes track
-- v(n+1) under a new id with every block and block session re-minted under
-- it, and the old version stays as it was. A block a later file leaves out is
-- therefore absent from the new version and kept on the superseded one's rows.
-- The current version of a lineage is the one with superseded_at null (one per
-- lineage, by index); a superseded version is also active = false.
--
-- IDS. v1 of a track keeps the backbone's trk_ id and its blocks the
-- backbone's trb_ ids; a later version's ids are minted. block_lineage_id
-- keeps the backbone trb_ id in every version.
--
-- A BLOCK SESSION NAMES A TEMPLATE BY LINEAGE (template_lineage_id), so a day
-- opens the template's current version. A lineage has many rows and its
-- one-head index is partial, so no foreign key can target it; the content
-- import refuses, by name, a lineage with no current active version in the
-- organization. A block session reaches its block by (track_id, block_order).
--
-- ORGANIZATION-SCOPED (R-ID-6): every row carries organization_id and goes
-- with the organization.
--
-- No begin;/commit; here, matching this repo's runner-opens-the-transaction
-- convention; the runner is apps/web/scripts/pilot-apply-training-tracks-migration.mjs
-- and it asserts every guarantee above before it commits. Idempotent.

do $$
begin
  if to_regclass('pilot.organizations') is null then
    raise exception 'TRAINING_TRACKS_NOT_READY: pilot.organizations does not exist -- apply the multi-organization migration first';
  end if;
end;
$$;

-- (1) The track ----------------------------------------------------------------------
-- details keeps every backbone field that has no column of its own, whole and
-- under its backbone name (for FT1: decision_cycle, daily_domain_order,
-- domain_roles, weekly_rhythm, friday_protocol, week_titles,
-- punch_introduction_guideline, primary_cue, coach_intervention_standards,
-- source_references_note). status and sources are the backbone record's own
-- (RULES section 10). The label columns (field_labels, evidence, stage_keys)
-- live beside the track in content_record_labels and content_stage_links.
create table if not exists pilot.training_tracks (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  track_id                 text not null,
  lineage_id               text not null,
  version                  integer not null default 1,
  supersedes_track_id      text null,
  superseded_at            timestamptz null,
  name                     text not null,
  lane                     text not null,
  track                    text null,
  duration_weeks           integer null,
  delivered_to_program_id  text null,
  age_band                 text not null default 'any',
  status                   text not null,
  sources                  text[] not null default '{}'::text[],
  details                  jsonb not null default '{}'::jsonb,
  active                   boolean not null default true,
  created_by_account_id    text null,
  created_by_role          text null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pilot_training_tracks_pkey primary key (organization_id, track_id),
  constraint pilot_training_tracks_lineage_version_uq unique (organization_id, lineage_id, version),
  constraint pilot_training_tracks_id_check check (track_id ~ '^trk_[0-9a-f]{14}$'),
  constraint pilot_training_tracks_lineage_check check (lineage_id ~ '^trk_[0-9a-f]{14}$'),
  constraint pilot_training_tracks_version_check check (version > 0),
  constraint pilot_training_tracks_name_check check (length(btrim(name, E' \t\r\n\f\v')) > 0),
  constraint pilot_training_tracks_lane_check check (lane in ('standard', 'non_contact')),
  constraint pilot_training_tracks_track_check check (track is null or track in ('contact', 'fitness')),
  constraint pilot_training_tracks_duration_check check (duration_weeks is null or duration_weeks > 0),
  constraint pilot_training_tracks_status_check check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_training_tracks_details_check check (jsonb_typeof(details) = 'object')
);

-- One current version per lineage: the engine supersedes the old head before
-- it inserts the new one (templateScriptVersions.ts, head 'not_superseded').
create unique index if not exists pilot_training_tracks_one_head_per_lineage
  on pilot.training_tracks(organization_id, lineage_id)
  where superseded_at is null;

comment on table pilot.training_tracks is
  'A multi-week class track (SCHEMA_PROPOSAL P17), per organization: gym-wide coaching content, no athlete. Versioned under R2 with its blocks and block sessions; the current version of a lineage has superseded_at null. details keeps every backbone field without a column, whole. Labels live in content_record_labels and content_stage_links (target_kind training_track).';

-- (2) The blocks of one track version -----------------------------------------------------
-- field_labels, evidence and stage_keys are the BLOCK's own backbone labels,
-- kept on the row (the label side tables hold one row per item version and the
-- engine writes them for the track only). details keeps every other backbone
-- field (for FT1: description, optional_drill_refs), whole.
create table if not exists pilot.track_blocks (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  track_block_id    text not null,
  block_lineage_id  text not null,
  track_id          text not null,
  block_order       integer not null,
  title             text null,
  weeks             integer null,
  status            text not null,
  sources           text[] not null default '{}'::text[],
  field_labels      jsonb null,
  evidence          jsonb null,
  stage_keys        text[] not null default '{}'::text[],
  details           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  constraint pilot_track_blocks_pkey primary key (organization_id, track_block_id),
  constraint pilot_track_blocks_track_fkey foreign key (organization_id, track_id)
    references pilot.training_tracks(organization_id, track_id) on delete cascade,
  constraint pilot_track_blocks_order_uq unique (organization_id, track_id, block_order),
  constraint pilot_track_blocks_lineage_uq unique (organization_id, track_id, block_lineage_id),
  constraint pilot_track_blocks_id_check check (track_block_id ~ '^trb_[0-9a-f]{14}$'),
  constraint pilot_track_blocks_lineage_check check (block_lineage_id ~ '^trb_[0-9a-f]{14}$'),
  constraint pilot_track_blocks_order_check check (block_order > 0),
  constraint pilot_track_blocks_weeks_check check (weeks is null or weeks > 0),
  constraint pilot_track_blocks_status_check check (status in ('OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED')),
  constraint pilot_track_blocks_field_labels_check check (field_labels is null or jsonb_typeof(field_labels) = 'object'),
  constraint pilot_track_blocks_evidence_check check (evidence is null or jsonb_typeof(evidence) in ('object', 'array')),
  constraint pilot_track_blocks_details_check check (jsonb_typeof(details) = 'object')
);

comment on table pilot.track_blocks is
  'An ordered multi-week unit of one training track VERSION (SCHEMA_PROPOSAL P17; not a session_script_block). block_lineage_id is the backbone trb_ id in every version. Rows of a superseded track version are kept as they were.';

-- (3) The sessions a block lists ---------------------------------------------------------
-- week is the week of the track (FT1 block 6 lists week 6), as the backbone
-- writes it; day as written, Monday to Sunday. ordinal is the position in the
-- block's list.
create table if not exists pilot.track_block_sessions (
  organization_id      text not null references pilot.organizations(organization_id) on delete cascade,
  block_session_id     text not null,
  track_id             text not null,
  block_order          integer not null,
  ordinal              integer not null,
  week                 integer not null,
  day                  text not null,
  template_lineage_id  text not null,
  created_at           timestamptz not null default now(),
  constraint pilot_track_block_sessions_pkey primary key (organization_id, block_session_id),
  constraint pilot_track_block_sessions_block_fkey foreign key (organization_id, track_id, block_order)
    references pilot.track_blocks(organization_id, track_id, block_order) on delete cascade,
  constraint pilot_track_block_sessions_ordinal_uq unique (organization_id, track_id, block_order, ordinal),
  constraint pilot_track_block_sessions_id_check check (block_session_id ~ '^tbs_[0-9a-f]{14}$'),
  constraint pilot_track_block_sessions_ordinal_check check (ordinal > 0),
  constraint pilot_track_block_sessions_week_check check (week > 0),
  constraint pilot_track_block_sessions_day_check
    check (day in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')),
  constraint pilot_track_block_sessions_template_check check (template_lineage_id ~ '^wtp_[0-9a-f]{14}$')
);

comment on table pilot.track_block_sessions is
  'A session a training track block lists, by week of the track and day (SCHEMA_PROPOSAL P17). template_lineage_id names a workout template LINEAGE, so the day opens its current version; checked at content import, not by foreign key.';
