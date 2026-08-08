-- Session scripts — the minute-by-minute layer a coach actually runs
--
-- WHY THIS EXISTS. The drill library answers "what is this drill and how is it scaled". It does
-- not answer the question a coach standing on the floor actually has, which is "what do I say
-- right now, what am I watching for, and what do I do when it goes wrong". A drill is reusable
-- across sessions; a script is the ordered, timed delivery of a session, and it carries teaching
-- content that belongs to the moment rather than to the drill.
--
-- THE STRUCTURE IS TAKEN FROM PPBF'S OWN COACH SCRIPTS, not invented here. The source Wednesday
-- level-2 script contains 62 timed blocks, each carrying up to four fields: what to say, what to
-- explain, what to watch, what to fix. Not every block carries every field, so all four are
-- nullable — a block with only "what to say" is a legitimate transition block, not an incomplete
-- row.
--
-- ROOM RECOVERY IS FIRST-CLASS. freeze, return to stance, one-sentence explanation, one
-- demonstration rep, restart slower. That is a session-level protocol rather than a per-block
-- field, and a new coach needs it more than any individual drill.
--
-- ONE SESSION, MANY DELIVERY FORMATS. PPBF authors the same session at four depths -- coach cheat
-- sheet, printable class plan, instructor script, optimized class flow. These are the same session
-- for different readers, so format is an attribute of a RENDERING, not a separate session.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.drill_library. No begin;/commit; here on
-- purpose, matching this repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-session-scripts-migration.mjs).

create table if not exists pilot.session_scripts (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  script_id           text not null,
  lineage_id          text not null,
  version             integer not null default 1,

  name                text not null,
  discipline          text not null default 'boxing',
  theme               text not null default '',        -- e.g. 'Perception -> Decision -> Composure'
  phase               text null,                        -- accumulation, sharpening, taper, etc.
  day_of_week         text null,
  total_minutes       integer null check (total_minutes is null or total_minutes between 10 and 300),

  -- A session may run non-contact and contact segments in the same room on one clock.
  contact_structure   text not null default 'non_contact' check (contact_structure in
                        ('non_contact','contact','split_non_contact_then_contact','observation_only')),
  target_group        text not null default '',        -- described in the coach's own terms
  prerequisite_note   text not null default '',

  -- Room recovery. Verbatim from the source manual; a new coach needs this before any drill.
  reset_protocol      text not null default '',
  coach_priorities    text not null default '',        -- ordered: safety, control of room, ...
  frequent_phrases    text not null default '',        -- the short cues repeated all session

  authoring_state     text not null default 'draft' check (authoring_state in
                        ('draft','coach_reviewed','in_use','retired')),
  source_document     text not null default '',        -- which PPBF manual this came from
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint pilot_session_scripts_pkey primary key (organization_id, script_id),
  constraint pilot_session_scripts_lineage_version_uq unique (organization_id, lineage_id, version)
);

create index if not exists pilot_session_scripts_active
  on pilot.session_scripts(organization_id, discipline, authoring_state);

-- ---------------------------------------------------------------------------
-- The timed blocks. This is the table the coach-facing screen reads.
create table if not exists pilot.session_script_blocks (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  block_id            text not null,
  script_id           text not null,
  block_order         integer not null check (block_order > 0),

  -- Offsets, not wall-clock. A session that starts at 4:00 and one that starts at 6:30 are the
  -- same script; storing '4:02 PM' would bind the content to one timetable.
  start_offset_min    integer not null check (start_offset_min >= 0),
  end_offset_min      integer not null,
  block_label         text not null,                   -- 'Add slip and visual response'

  what_to_say         text null,
  what_to_explain     text null,
  what_to_watch       text null,
  what_to_fix         text null,

  block_kind          text not null default 'instruction' check (block_kind in
                        ('arrival','instruction','demonstration','drill_round','reset_minute',
                         'teaching_minute','transition','conditioning','reflection','close')),
  drill_id            text null,                       -- links to the library when a block runs one
  scale_level         text null check (scale_level is null or scale_level in ('A','B','C')),
  contact_level       text not null default 'none',

  constraint pilot_ssb_pkey primary key (organization_id, block_id),
  constraint pilot_ssb_script_fk foreign key (organization_id, script_id)
    references pilot.session_scripts(organization_id, script_id) on delete cascade,
  constraint pilot_ssb_drill_fk foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id),
  constraint pilot_ssb_order_uq unique (organization_id, script_id, block_order),
  constraint pilot_ssb_window check (end_offset_min > start_offset_min),
  -- A block must teach something or move the room. An empty block is an authoring error.
  constraint pilot_ssb_content check (
    coalesce(what_to_say, what_to_explain, what_to_watch, what_to_fix) is not null
    or block_kind in ('transition','arrival','close')
  )
);

create index if not exists pilot_ssb_script
  on pilot.session_script_blocks(organization_id, script_id, block_order);

-- ---------------------------------------------------------------------------
-- Delivery formats. Same session, different reader.
create table if not exists pilot.session_script_renderings (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  rendering_id        text not null,
  script_id           text not null,
  format              text not null check (format in
                        ('cheat_sheet','class_plan','instructor_script','class_flow','athlete_handout','parent_summary')),
  audience_note       text not null default '',
  body                text not null,
  generated_from_blocks boolean not null default false,  -- true when derived, false when hand-authored
  created_at          timestamptz not null default now(),
  constraint pilot_ssr_pkey primary key (organization_id, rendering_id),
  constraint pilot_ssr_script_fk foreign key (organization_id, script_id)
    references pilot.session_scripts(organization_id, script_id) on delete cascade,
  constraint pilot_ssr_format_uq unique (organization_id, script_id, format)
);

comment on table pilot.session_script_renderings is
  'One session rendered for different readers. Four formats are already authored by PPBF: cheat sheet, class plan, instructor script, class flow.';

-- ---------------------------------------------------------------------------
-- What actually happened. A script is a plan; this is the record of running it.
-- Kept separate so the plan is not overwritten by any single delivery, and so a coach's
-- deviations become visible rather than silently editing the script.
create table if not exists pilot.session_script_runs (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  run_id              text not null,
  script_id           text not null,
  script_version      integer not null,
  activity_id         text null,
  delivered_by_account_id text not null references pilot.accounts(account_id),
  delivered_on        date not null,
  athletes_present    integer null check (athletes_present is null or athletes_present >= 0),
  blocks_completed    integer null,
  reset_protocol_used boolean not null default false,
  deviation_note      text not null default '',
  what_worked         text not null default '',
  what_did_not        text not null default '',
  created_at          timestamptz not null default now(),
  constraint pilot_ssrun_pkey primary key (organization_id, run_id),
  constraint pilot_ssrun_script_fk foreign key (organization_id, script_id)
    references pilot.session_scripts(organization_id, script_id) on delete cascade
);

create index if not exists pilot_ssrun_script
  on pilot.session_script_runs(organization_id, script_id, delivered_on desc);
