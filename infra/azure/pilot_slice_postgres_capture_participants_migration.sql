-- TS-ANON-01: anonymous teaching media, with a restricted safeguarding link.
--
-- THE OWNER RULE THIS IMPLEMENTS. Teaching media names nobody. Athlete
-- identity belongs to Film Study. Today a take-backed video stores
-- pilot.video_sessions.athlete_id, and that column is what the scan sweep uses
-- to find a guardian to ask -- so identity and consent-checking are currently
-- the same switch. Removing the column alone would not make the media
-- anonymous, it would make the consent check silently stop happening.
--
-- SO THE LINK MOVES RATHER THAN DISAPPEARS. The teaching row loses its
-- athlete_id; a restricted control plane keeps the relationship, and only for
-- the three uses the owner approved: verify consent, enforce withdrawal,
-- handle safeguarding events. Nothing in Teach Shadow reads it, and it is
-- never a model input.
--
--   TEACHING SIDE                    RESTRICTED CONTROL PLANE
--   video_sessions                   video_capture_participants
--     capture_take_id  not null   ->   capture_participants -> athletes
--     athlete_id       NULL            recording_session_participants
--
-- WHY A PARTICIPANT ROW AND NOT athlete_id ON A SIDE TABLE. A column named
-- something else holding the same value is the same leak with a different
-- name: every later join would reach it, and "anonymous" would be a naming
-- convention rather than a property. The participant id is the thing teaching
-- tables may see; resolving it to a person is a separate, restricted step.
--
-- WHY THE JUNCTIONS ARE MANY-TO-MANY even though exactly one person is filmed
-- today. shadowboxing and heavy_bag are the only enabled contexts and both are
-- single-subject, so a unique constraint on video_session_id would hold right
-- now -- and would be wrong the moment mitts or sparring are enabled, which is
-- the direction this model exists to grow into. A constraint that has to be
-- dropped by a later migration is worse than one never added: the single
-- subject is enforced where the contexts are enforced, on the server, and this
-- schema stays the shape the next slice extends rather than undoes.
--
-- CONSENT IS NOT SCHEMA HERE. pilot.waivers.waiver_type is plain text with no
-- check constraint, so the new 'teach_shadow_ml' purpose needs no DDL. It is
-- deliberately a distinct waiver_type from 'photo_media': publication consent
-- does not authorise teaching use and teaching consent does not authorise
-- publication. Keeping them as separate rows in the one append-only ledger is
-- what makes them independently grantable, withdrawable and auditable.
--
-- ADDITIVE. The already-applied capture-sessions migration is not rewritten.

-- ---------------------------------------------------------------------------
-- A prerequisite this migration declares rather than assumes.
--
-- video_capture_participants points at (organization_id, video_session_id),
-- which needs a matching unique on the parent. That unique is added by the
-- calibration-projects migration, and `all` happens to run that first -- but
-- depending on an unrelated migration for a constraint this one's foreign key
-- requires is a silent ordering coupling, and it breaks the moment anything
-- applies these in a different set. Same name and same shape as
-- calibration-projects uses, so whichever runs first wins and the other
-- no-ops.
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
-- The restricted identity itself.
-- ---------------------------------------------------------------------------

create table if not exists pilot.capture_participants (
  capture_participant_id text primary key,
  organization_id text not null,
  -- The real person. This column is the reason the table is restricted, and it
  -- is the only place a teaching capture can be resolved to a human.
  athlete_id text not null,
  created_by_account_id text not null,
  created_at timestamptz not null default now(),
  -- Carries the organization so every onward reference can be composite; see
  -- the capture-sessions migration for why application scoping is a habit and
  -- a foreign key is a guarantee.
  constraint capture_participants_org_scoped_unique
    unique (organization_id, capture_participant_id),
  constraint capture_participants_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint capture_participants_created_by_fk
    foreign key (created_by_account_id)
    references pilot.accounts(account_id)
);

-- One participant row per athlete per organization. A second row for the same
-- person would fragment consent and withdrawal: a guardian withdrawing would
-- reach one participant id and leave footage hanging off the other.
create unique index if not exists idx_capture_participants_org_athlete
  on pilot.capture_participants(organization_id, athlete_id);

-- ---------------------------------------------------------------------------
-- Who a filming session is of.
-- ---------------------------------------------------------------------------

create table if not exists pilot.recording_session_participants (
  organization_id text not null,
  recording_session_id text not null,
  capture_participant_id text not null,
  created_at timestamptz not null default now(),
  primary key (recording_session_id, capture_participant_id),
  constraint recording_session_participants_session_fk
    foreign key (organization_id, recording_session_id)
    references pilot.recording_sessions(organization_id, recording_session_id)
    on delete cascade,
  constraint recording_session_participants_participant_fk
    foreign key (organization_id, capture_participant_id)
    references pilot.capture_participants(organization_id, capture_participant_id)
    on delete cascade
);

create index if not exists idx_recording_session_participants_participant
  on pilot.recording_session_participants(organization_id, capture_participant_id);

-- ---------------------------------------------------------------------------
-- Who a single teaching video is of. Separate from the session link because a
-- device can join a session and upload its own angle: the video is the thing
-- consent is checked against at scan time, so the link has to reach the video
-- without walking back up to the session every time.
-- ---------------------------------------------------------------------------

create table if not exists pilot.video_capture_participants (
  organization_id text not null,
  video_session_id text not null,
  capture_participant_id text not null,
  created_at timestamptz not null default now(),
  primary key (video_session_id, capture_participant_id),
  constraint video_capture_participants_video_fk
    foreign key (organization_id, video_session_id)
    references pilot.video_sessions(organization_id, video_session_id)
    on delete cascade,
  constraint video_capture_participants_participant_fk
    foreign key (organization_id, capture_participant_id)
    references pilot.capture_participants(organization_id, capture_participant_id)
    on delete cascade
);

-- The scan sweep's lookup: given a video it is about to screen, who must have
-- consented.
create index if not exists idx_video_capture_participants_video
  on pilot.video_capture_participants(organization_id, video_session_id);

-- The withdrawal lookup, in the other direction: given a participant whose
-- guardian just withdrew, which teaching videos stop being eligible.
create index if not exists idx_video_capture_participants_participant
  on pilot.video_capture_participants(organization_id, capture_participant_id);

-- ---------------------------------------------------------------------------
-- EXISTING TEACHING ROWS.
--
-- Rows written before this rule carry athlete_id on the teaching video. They
-- are not deleted and their identity is not silently dropped: the relationship
-- is preserved into the restricted control plane FIRST, and only then is the
-- teaching column cleared. Order matters -- clearing first would destroy the
-- only record of who is in footage this platform still holds.
--
-- FAILS RATHER THAN GUESSES. If one supposedly single-subject recording
-- session turns out to hold rows naming different athletes, this raises
-- instead of picking one. A wrong participant link would attach one child's
-- footage to another child's consent, which is the worst outcome available
-- here and is not something a migration may decide quietly.
-- ---------------------------------------------------------------------------

do $$
declare
  conflicting integer;
begin
  select count(*) into conflicting
  from (
    select vs.recording_session_id
    from pilot.video_sessions vs
    where vs.capture_take_id is not null
      and vs.athlete_id is not null
      and vs.recording_session_id is not null
    group by vs.recording_session_id
    having count(distinct vs.athlete_id) > 1
  ) as mixed;

  if conflicting > 0 then
    raise exception
      'TS-ANON-01: % recording session(s) hold take-backed videos naming more than one athlete. '
      'Single-subject provenance is ambiguous for those rows, so participant links cannot be '
      'derived without guessing. Resolve them by hand before re-running this migration.',
      conflicting;
  end if;
end
$$;

-- Derive a restricted participant for every athlete who appears on an existing
-- teaching video. Idempotent: re-running adds nothing.
insert into pilot.capture_participants (
  capture_participant_id, organization_id, athlete_id, created_by_account_id, created_at
)
select
  'cp_' || md5(vs.organization_id || ':' || vs.athlete_id),
  vs.organization_id,
  vs.athlete_id,
  -- Attributed to whoever uploaded the footage this link was derived from, so
  -- the provenance of the link is answerable and is not attributed to a person
  -- who never acted.
  min(vs.uploaded_by_account_id),
  min(vs.created_at)
from pilot.video_sessions vs
where vs.capture_take_id is not null
  and vs.athlete_id is not null
  and vs.uploaded_by_account_id is not null
group by vs.organization_id, vs.athlete_id
on conflict (organization_id, athlete_id) do nothing;

insert into pilot.video_capture_participants (
  organization_id, video_session_id, capture_participant_id
)
select vs.organization_id, vs.video_session_id, cp.capture_participant_id
from pilot.video_sessions vs
join pilot.capture_participants cp
  on cp.organization_id = vs.organization_id
 and cp.athlete_id = vs.athlete_id
where vs.capture_take_id is not null
  and vs.athlete_id is not null
on conflict (video_session_id, capture_participant_id) do nothing;

insert into pilot.recording_session_participants (
  organization_id, recording_session_id, capture_participant_id
)
select distinct vs.organization_id, vs.recording_session_id, cp.capture_participant_id
from pilot.video_sessions vs
join pilot.capture_participants cp
  on cp.organization_id = vs.organization_id
 and cp.athlete_id = vs.athlete_id
where vs.capture_take_id is not null
  and vs.athlete_id is not null
  and vs.recording_session_id is not null
on conflict (recording_session_id, capture_participant_id) do nothing;

-- ONLY NOW. Every cleared row above has a durable restricted link, and the
-- guard below refuses to clear anything that does not -- so a partial failure
-- above cannot strand footage with no way back to a guardian.
update pilot.video_sessions vs
set athlete_id = null,
    updated_at = now()
where vs.capture_take_id is not null
  and vs.athlete_id is not null
  and exists (
    select 1
    from pilot.video_capture_participants vcp
    where vcp.organization_id = vs.organization_id
      and vcp.video_session_id = vs.video_session_id
  );

do $$
declare
  stranded integer;
begin
  select count(*) into stranded
  from pilot.video_sessions vs
  where vs.capture_take_id is not null
    and vs.athlete_id is not null;

  if stranded > 0 then
    raise exception
      'TS-ANON-01: % take-backed video(s) still carry athlete_id after migration. '
      'They had no derivable restricted participant link and were left untouched rather '
      'than anonymised with no way back to a guardian. Investigate before proceeding.',
      stranded;
  end if;
end
$$;
