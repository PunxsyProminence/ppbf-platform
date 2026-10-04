-- Video clip tags: a sparring or bout video tagged to the athletes in it and
-- to the event it records, so a coach can pull up an athlete's clips.
--
-- Owner decisions (Jason, 2026-10-03, lane "video tagging"):
--   * Tagged clips are staff only: coaches and organization admins.
--   * When a clip shows several athletes, a withdrawn or photo-only media
--     consent for ANY of them blocks playback of the whole clip.
--   * A coach may review a clip when any tagged athlete is theirs, subject to
--     the consent rule above.
-- Those rules live in the application (videoClipTags.ts and the playback
-- route); this file owns the shape and the integrity of the link only.
--
-- HUMAN FILM STUDY ONLY. Nothing here scores footage (BACKLOG-video-skill-
-- scoring stays parked).
--
-- SPARRING LINK DEFERRED. A sparring clip is tagged by kind only for now. The
-- link to the athlete's sparring_exposure row waits for the sparring entry
-- lane's migration to merge (overwatch, 2026-10-03), and lands as its own
-- additive migration.
--
-- ADDITIVE AND IDEMPOTENT. One new table, its indexes, and one unique index on
-- pilot.video_sessions that the composite foreign key needs. No existing row
-- or column changes. Requires the video-sessions and external-competition
-- migrations. The runner opens the transaction, so this file carries none.

-- Composite target for the video foreign key. video_session_id is already
-- unique on its own, so this index cannot fail on existing data.
create unique index if not exists idx_video_sessions_org_video
  on pilot.video_sessions(organization_id, video_session_id);

create table if not exists pilot.video_clip_tags (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  tag_id                text not null,
  video_session_id      text not null,
  athlete_id            text not null,
  event_kind            text not null,
  -- Competition: required. The foreign key below admits only a competition
  -- this athlete is entered in.
  competition_id        text null,
  note                  text not null default '',
  tagged_by_account_id  text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  removed_at            timestamptz null,
  removed_by_account_id text null references pilot.accounts(account_id),
  constraint pilot_video_clip_tags_pkey primary key (organization_id, tag_id),
  constraint pilot_video_clip_tags_video_fk foreign key (organization_id, video_session_id)
    references pilot.video_sessions(organization_id, video_session_id) on delete cascade,
  constraint pilot_video_clip_tags_athlete_fk foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_video_clip_tags_entry_fk foreign key (organization_id, competition_id, athlete_id)
    references pilot.external_competition_entries(organization_id, competition_id, athlete_id) on delete cascade,
  constraint pilot_video_clip_tags_event_check check (
    (event_kind = 'sparring' and competition_id is null)
    or (event_kind = 'competition' and competition_id is not null)
  ),
  constraint pilot_video_clip_tags_note_check check (length(note) <= 500),
  constraint pilot_video_clip_tags_removed_check check ((removed_at is null) = (removed_by_account_id is null))
);

-- One live tag per athlete per video. A removed tag stays as the record of
-- who tagged and who removed it.
create unique index if not exists idx_video_clip_tags_one_live
  on pilot.video_clip_tags(organization_id, video_session_id, athlete_id)
  where removed_at is null;

create index if not exists idx_video_clip_tags_athlete
  on pilot.video_clip_tags(organization_id, athlete_id, created_at desc)
  where removed_at is null;

create index if not exists idx_video_clip_tags_competition
  on pilot.video_clip_tags(organization_id, competition_id)
  where removed_at is null and competition_id is not null;

comment on table pilot.video_clip_tags is
  'Sparring and bout video tagged to athletes and their event, for staff film study. Owner 2026-10-03: staff only; any tagged athlete''s consent block blocks the whole clip. No AI scoring.';
