-- CAP-VID-01: grouped multi-angle capture.
--
-- WHAT THIS EXISTS FOR. Several coaches film the same punch from different
-- positions, each on their own phone, each producing its own file. Nothing in
-- pilot.video_sessions could say those files belong together: it carries one
-- source file and no notion of a filming session, an attempt, or a viewpoint.
-- Without that, three angles of one jab are three unrelated videos, and a
-- dataset built from them cannot keep alternate views of the same punch on the
-- same side of a train/test split -- which is the one property that stops a
-- model being scored against footage it has effectively already seen.
--
-- THREE IDENTITIES, NOT ONE, because they answer different questions:
--   recording_session  which filming session was this
--   capture_take       which simultaneous attempt was this
--   camera_view        which camera/file within that attempt
--
-- WHAT IS DELIBERATELY ABSENT: physical_event_group_id. One take of a
-- five-punch combination filmed by three cameras is three files and fifteen
-- observable event instances that later resolve into five physical events.
-- That grouping is an annotation-time fact about EVENTS and stamping it onto a
-- whole video row would assert a correspondence nobody has established yet.
--
-- WHAT THIS DOES NOT CLAIM. A grouped recording is governed SOURCE footage. It
-- is not training data, not gold, and not ML-eligible; eligibility is decided
-- elsewhere against consent and dataset governance, and nothing here should be
-- read as granting it.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-capture-sessions-migration.mjs) opens the
-- transaction itself, matching the video-sessions / waiver-recorded-by
-- convention rather than the shadow-runtime one.

create table if not exists pilot.recording_sessions (
  recording_session_id text primary key,
  organization_id text not null,
  created_by_account_id text not null,
  -- The kind of training being filmed. A closed vocabulary because it becomes
  -- a slice dimension when performance is measured -- "weak on heavy bag,
  -- strong on shadow" is only answerable if this is not free text.
  training_context text not null
    check (training_context in ('shadowboxing', 'heavy_bag', 'mitts', 'sparring', 'other')),
  -- CORRELATION, NOT AUTHORIZATION. Typing this code grants nothing: the API
  -- still requires an authenticated coach or organization_admin of the same
  -- organization. It exists so a second device can say WHICH session it is
  -- joining, not to prove it may. That is why it is stored in plaintext,
  -- unlike pilot.activation_codes, which are hashed precisely because
  -- possessing one IS the credential.
  join_code text not null,
  state text not null default 'open'
    check (state in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  -- Not redundant with the primary key. It is the TARGET every composite
  -- foreign key below points at, which is what makes a cross-organization
  -- relationship unrepresentable rather than merely unlikely. Same device the
  -- calibration schema uses for the same reason.
  constraint recording_sessions_org_scoped_unique unique (organization_id, recording_session_id)
);

-- A join code only has to be unambiguous among the sessions you could still
-- join. Partial on state so a code becomes reusable once its session closes,
-- which keeps codes short enough to read across a gym.
create unique index if not exists idx_recording_sessions_open_code
  on pilot.recording_sessions(organization_id, join_code)
  where state = 'open';

create index if not exists idx_recording_sessions_org_created
  on pilot.recording_sessions(organization_id, created_at desc);

create table if not exists pilot.capture_takes (
  capture_take_id text primary key,
  recording_session_id text not null,
  organization_id text not null,
  -- Human-facing within its session: "take 3", not a uuid nobody can say out
  -- loud while standing on the gym floor.
  take_number integer not null check (take_number > 0),
  state text not null default 'open'
    check (state in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint capture_takes_number_unique unique (recording_session_id, take_number),
  constraint capture_takes_org_scoped_unique unique (organization_id, capture_take_id),
  /*
   * COMPOSITE, CARRYING organization_id, and that is the whole point. A
   * single-column reference to recording_session_id would let a take in one
   * gym name a session in another: the routes happen to scope their reads
   * correctly, but application scoping is a habit and a foreign key is a
   * guarantee. With the organization in the key, the contradictory row cannot
   * be written at all -- which is the standard the calibration schema already
   * holds itself to.
   */
  constraint capture_takes_recording_session_fk
    foreign key (organization_id, recording_session_id)
    references pilot.recording_sessions(organization_id, recording_session_id)
    on delete cascade
);

-- ONE OPEN TAKE AT A TIME, enforced by the database rather than by whichever
-- device asked last. Two open takes would let two phones record what they each
-- believe is "the current attempt" and attach the files to different takes --
-- the exact failure this table exists to prevent, and one that would only be
-- discovered later, in the data.
create unique index if not exists idx_capture_takes_one_open
  on pilot.capture_takes(recording_session_id)
  where state = 'open';

-- The capture provenance on the source file itself. Every column is NULLABLE
-- and that is not laziness: every video already in the platform was uploaded
-- before any of this existed, and there is no honest value to backfill. A
-- video with no recording_session_id is an ungrouped upload, which is a true
-- statement about it. Inventing a session per legacy row would manufacture
-- provenance the platform never had.
alter table pilot.video_sessions
  add column if not exists recording_session_id text null,
  add column if not exists capture_take_id text null,
  add column if not exists camera_view_id text null,
  add column if not exists camera_view text null,
  add column if not exists recorded_at timestamptz null,
  add column if not exists capture_source text null;

-- recorded_at is WHEN THE FOOTAGE WAS SHOT, which is not created_at (when the
-- row was written) and not updated_at. On a phone that recorded in a basement
-- and uploaded on the drive home these differ by hours, and the one that
-- belongs in a dataset is the former.
comment on column pilot.video_sessions.recorded_at is
  'When the footage was captured, distinct from when the row was created.';

-- A PPBF-minted identity for this view/file. NOT a browser device id and NOT a
-- hardware fingerprint: those identify a person''s phone across sessions,
-- which is surveillance this has no need for. It only has to distinguish this
-- camera from the others in the same take.
comment on column pilot.video_sessions.camera_view_id is
  'PPBF-generated per-file view identity. Never a device or hardware identifier.';

-- The semantic viewpoint when a human said what it was. Deliberately free text
-- and deliberately allowed to be unknown, because "rear phone camera" is a
-- fact about the hardware and "rear view of the athlete" is a fact about the
-- gym, and inferring the second from the first is how a dataset acquires
-- labels nobody checked.
comment on column pilot.video_sessions.camera_view is
  'Human-described viewpoint when known. Unknown is a permitted answer.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.video_sessions'::regclass
      and conname = 'video_sessions_capture_source_check'
  ) then
    alter table pilot.video_sessions
      add constraint video_sessions_capture_source_check
      check (capture_source is null or capture_source in ('in_app_recording', 'file_upload'));
  end if;

  /*
   * COMPOSITE, so a video in one organization cannot name a session or take in
   * another. The routes scope their reads, but that is application discipline;
   * this makes the contradictory row unrepresentable.
   *
   * THE NULLABILITY IS LOAD-BEARING AND CORRECT. Default MATCH SIMPLE means a
   * composite foreign key is not enforced when ANY of its columns is NULL.
   * organization_id is never null, so for an ordinary ungrouped upload -- where
   * recording_session_id and capture_take_id are both NULL -- the constraint
   * stands down entirely, which is exactly right: every video that predates
   * this migration is that shape. The moment a grouping id IS present, the pair
   * must match a real row in the same organization.
   *
   * ON DELETE SET NULL, not CASCADE and not RESTRICT. Deleting a recording
   * session must never delete the footage, and must never be blocked by it:
   * the retention purge hard-deletes rows, and a restricting constraint here
   * would abort that sweep. Losing the grouping while keeping the video is the
   * right direction to fail in.
   */
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.video_sessions'::regclass
      and conname = 'video_sessions_recording_session_fk'
  ) then
    alter table pilot.video_sessions
      add constraint video_sessions_recording_session_fk
      foreign key (organization_id, recording_session_id)
      references pilot.recording_sessions(organization_id, recording_session_id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'pilot.video_sessions'::regclass
      and conname = 'video_sessions_capture_take_fk'
  ) then
    alter table pilot.video_sessions
      add constraint video_sessions_capture_take_fk
      foreign key (organization_id, capture_take_id)
      references pilot.capture_takes(organization_id, capture_take_id)
      on delete set null;
  end if;
end
$$;

-- The query this exists for: every file belonging to one take, which is what
-- the capture surface and any later alignment work both read.
create index if not exists idx_video_sessions_capture_take
  on pilot.video_sessions(capture_take_id)
  where capture_take_id is not null;
