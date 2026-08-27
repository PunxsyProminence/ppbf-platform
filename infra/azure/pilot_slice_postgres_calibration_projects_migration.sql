-- Calibration projects and clips (pilot.calibration_projects,
-- pilot.calibration_clips) -- the foundation of the human video-annotation
-- calibration system, owner-authorized under boxing-ontology-0.1.
--
-- WHAT A CALIBRATION PROJECT IS. A named experiment: "take these short spans
-- of our own footage, have two people label them independently under a fixed
-- vocabulary, and find out where trained humans disagree." Its output is a
-- measurement of the ANNOTATION PROCESS. It is not a measurement of any
-- athlete, and nothing in this schema may be read as one.
--
-- WHAT A CLIP IS -- AND WHAT IT IS NOT. A clip is a TIME RANGE over a video
-- that already exists in pilot.video_sessions. It is a pointer, not a file.
-- There is deliberately no blob_path, no derived-media column, and no frame
-- storage of any kind here, for exactly the reason the Film Study proposals
-- migration gives for refusing frame_blob_path: this platform holds footage
-- of minors, and a schema that CAN quietly accumulate copies of it eventually
-- will. Cutting a clip creates a row of integers. It creates no new copy of a
-- child's video, and this table cannot be used to make one.
--
-- A FRAME OFFSET IS NOT A FRAME IMAGE. start_ms and end_ms say WHEN to look
-- in a video the platform already holds under its existing consent, scan and
-- retention rules. They carry no pixels. That distinction is the whole reason
-- this table is allowed to exist beside the no-frame-storage doctrine rather
-- than in tension with it.
--
-- QUARANTINE IS NOT TOUCHED. Nothing here releases, promotes, or widens
-- access to any video. A clip may only be cut from a video the organization
-- can already play, and the read path re-checks that on every access rather
-- than trusting this row -- see the note on the video foreign key below.
--
-- CALIBRATION DATA IS NOT ATHLETE TRUTH. athlete_id is recorded for scoping
-- and deletion, never so that a calibration finding can be attributed to a
-- boxer. No coaching surface reads these tables, no formula consumes them,
-- and no SHADOW event is emitted from them.
--
-- Additive and idempotent. Everything below is `if not exists` or catalog
-- guarded, so the `all` chain's re-apply on every dispatch (#489) is a no-op.
--
-- DEPENDS ON: pilot_slice_postgres.sql (organizations, accounts, athletes)
-- and pilot_slice_postgres_video_sessions_migration.sql. The dependency on
-- video_sessions is REAL and not merely conventional -- the do-block below
-- alters it. In the apply-migrations `all` chain this migration is appended
-- last, so its dependencies are already applied. The schema verifier applies
-- files in sorted filename order, where `calibration` sorts before `video`;
-- that is what its multi-pass retry loop exists for, and this file is written
-- to be safely re-runnable across those passes.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-calibration-projects-migration.mjs) opens the
-- transaction itself, matching the announcements / video-sessions /
-- film-study convention. The shadow-runtime runner takes the opposite
-- convention, and mixing them took every migration in that set down once
-- (#107).

-- ---------------------------------------------------------------------------
-- PREREQUISITE: give pilot.video_sessions a tenancy-composite key.
--
-- Every other multi-org child table in pilot.* prevents cross-organization
-- references STRUCTURALLY, with a composite foreign key onto the parent's
-- (organization_id, <parent>_id) -- see pilot.drill_scale_levels ->
-- pilot.drill_library, or pilot.athlete_check_ins -> pilot.athletes. That
-- pattern makes "clip in org A pointing at a video in org B" not a bug to be
-- caught by a code review but a row the database refuses to store.
--
-- pilot.video_sessions cannot be the target of that pattern today: it was
-- promoted out of route DDL and carries no keys beyond its primary key, which
-- its own migration documents as a deliberate deferral. So the composite key
-- is added here, by the first table that needs it.
--
-- THIS CANNOT FAIL ON EXISTING DATA. video_session_id is already the primary
-- key, so it is already unique across the whole table; any superset of a
-- unique column set is unique by construction. There is no row, in any
-- environment, that this constraint can reject. It adds an index and takes
-- nothing away.
--
-- It is added here rather than in the video-sessions migration because that
-- file's shape is pinned column-by-column by videoSessionsSchemaOwnership.ts
-- against what live environments already carry, and because the requirement
-- originates with this feature. Guarded on the relation existing so a
-- sorted-order first pass skips rather than aborts.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pilot.video_sessions') is not null
    and not exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('pilot.video_sessions')
        and conname = 'pilot_video_sessions_org_video_uq'
    )
  then
    alter table pilot.video_sessions
      add constraint pilot_video_sessions_org_video_uq
      unique (organization_id, video_session_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The experiment.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_projects (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  calibration_project_id text not null,

  -- Operator-facing name. Unique per organization so two studies cannot share
  -- an identity in the one place a human distinguishes them.
  name text not null check (length(btrim(name)) > 0),

  -- The vocabulary this study was run under, stamped on the project and
  -- copied onto every clip, annotation set and event beneath it.
  --
  -- Stored as free text rather than pinned to a single literal ON PURPOSE. A
  -- CHECK naming 'boxing-ontology-0.1' would mean the ontology could not gain
  -- a version without a schema migration, which is the wrong place for that
  -- decision to live. The application refuses any value it does not
  -- recognise (calibration/ontology.ts owns the list); the database's job
  -- here is only to guarantee that SOME version is always recorded, so no row
  -- can exist whose vocabulary is unknown.
  --
  -- Two studies under two versions are two different measurements. Nothing in
  -- this subsystem may pool across versions without a recorded decision.
  ontology_version text not null check (length(btrim(ontology_version)) > 0),

  -- Where the study is in its life. A WORKFLOW state, never a quality
  -- judgement: 'completed' means the passes finished, not that the numbers
  -- were good, and nothing downstream may read it as validation.
  status text not null default 'draft'
    check (status in ('draft', 'annotating', 'adjudicating', 'completed', 'archived')),

  created_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_calibration_projects_pkey
    primary key (organization_id, calibration_project_id),
  constraint pilot_calibration_projects_name_uq
    unique (organization_id, name)
);

create index if not exists idx_calibration_projects_org_status
  on pilot.calibration_projects(organization_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- The sampled spans.
-- ---------------------------------------------------------------------------
create table if not exists pilot.calibration_clips (
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,
  calibration_clip_id text not null,
  calibration_project_id text not null,

  -- The source footage. A REFERENCE -- see the header: no copy is made.
  video_session_id text not null,

  -- Nullable, because unattributed team footage is a first-class case
  -- throughout the video subsystem and is in fact the PREFERABLE source for a
  -- calibration study: measuring how two annotators label a punch needs no
  -- boxer's name attached to it. Where it IS set, it exists so the clip
  -- inherits that athlete's access control and so a deletion request reaches
  -- this row (see the cascade on the athlete foreign key).
  athlete_id text null,

  -- Short human-usable label ('C-01'). Unique within the project because
  -- annotators, adjudicators and the QA read-out all refer to clips by it.
  clip_code text not null check (length(btrim(clip_code)) > 0),

  -- Milliseconds from the start of the source video.
  --
  -- MILLISECONDS, NOT FRAMES. v0.1 makes no claim to frame-accurate timing:
  -- the platform stores no frame rate, the browser exposes no reliable frame
  -- index, and a column named frame_number would be asserting a precision
  -- nothing in the stack can deliver. Milliseconds are what the media element
  -- actually reports.
  --
  -- integer, not bigint: 2.1e9 ms is 24 days of footage. bigint here would
  -- cost every reader an int8-arrives-as-a-string conversion (node-postgres
  -- returns OID 20 as text) to buy a range no gym video will reach.
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,

  -- WHY this clip was sampled. The stratification key -- the field that turns
  -- "annotators disagreed 18% of the time" into "4% on isolated punches, 38%
  -- on simultaneous exchanges". Required for that reason.
  --
  -- Records the SELECTOR'S INTENT at sampling time. It is never re-derived
  -- from what the annotations later contained; rewriting it afterwards would
  -- quietly turn a stratified sample into a convenience sample.
  primary_sampling_reason text not null
    check (primary_sampling_reason in (
      'isolated_punch',
      'combination',
      'defense',
      'counter',
      'head_body_mix',
      'opposite_stance',
      'stance_switch',
      'guard_contact',
      'occlusion',
      'simultaneous_exchange',
      'other'
    )),

  created_by_account_id text not null references pilot.accounts(account_id),
  created_at timestamptz not null default now(),

  constraint pilot_calibration_clips_pkey
    primary key (organization_id, calibration_clip_id),

  -- A clip is a span, so it must have width. This also subsumes end_ms > 0.
  --
  -- NOT VALIDATED AGAINST THE VIDEO'S LENGTH, because the platform does not
  -- store one: pilot.video_sessions has no duration column. A clip whose
  -- end_ms runs past the end of the footage is accepted here and will simply
  -- play short. Recorded as a known gap rather than papered over with an
  -- invented ceiling.
  constraint pilot_calibration_clips_bounds check (start_ms < end_ms),

  -- TENANCY, ENFORCED BY THE DATABASE. Each of the three references below is
  -- composite on organization_id, so a clip cannot point at a project, a
  -- video, or an athlete belonging to another organization. Not "should not":
  -- cannot.
  constraint pilot_calibration_clips_project_fk
    foreign key (organization_id, calibration_project_id)
    references pilot.calibration_projects(organization_id, calibration_project_id)
    on delete cascade,

  -- ON DELETE CASCADE, deliberately, and this is the safeguarding-relevant
  -- choice. If the source footage is deleted -- including by a data-deletion
  -- request on behalf of a minor -- every calibration row derived from it goes
  -- with it. The alternative, RESTRICT, would let a research dataset block a
  -- child's deletion right. Research convenience does not outrank that, so
  -- calibration data is downstream of deletion, never an anchor against it.
  constraint pilot_calibration_clips_video_fk
    foreign key (organization_id, video_session_id)
    references pilot.video_sessions(organization_id, video_session_id)
    on delete cascade,

  -- MATCH SIMPLE (the default) means this is not enforced when athlete_id is
  -- null, which is exactly right: null is unattributed footage, not a dangling
  -- reference. Where it is set, the same cascade reasoning applies.
  constraint pilot_calibration_clips_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,

  constraint pilot_calibration_clips_code_uq
    unique (organization_id, calibration_project_id, clip_code)
);

create index if not exists idx_calibration_clips_project
  on pilot.calibration_clips(organization_id, calibration_project_id, clip_code);

-- Sampling-reason strata, for the QA read-out.
create index if not exists idx_calibration_clips_sampling_reason
  on pilot.calibration_clips(organization_id, primary_sampling_reason);

-- "Which clips were cut from this video" -- the read a deletion or retention
-- review needs.
create index if not exists idx_calibration_clips_video
  on pilot.calibration_clips(organization_id, video_session_id);
