-- Athlete mental skills (map item 21, PR A): the athlete's own self-talk cue
-- and a log of the short imagery sessions they did. Written by the athlete;
-- read by the athlete, their linked guardian, their coach and the org admin
-- (owner answers 2026-10-04: athletes type their own cue; minors included;
-- guardian sees the log).
--
-- ONE ROW = ONE THING THE ATHLETE DID. Two kinds:
--   self_talk_cue   -- a short phrase in the athlete's own words, tagged
--                      instructional (technique) or motivational (effort).
--                      The newest one is their current cue; earlier rows are
--                      kept, because a cue they used is part of their record.
--   imagery_session -- "I did an imagery session today, for N minutes",
--                      optionally naming which approved content it was.
--
-- WHAT THIS IS NOT. Not an assessment, not a score, not a mental-health
-- record. No vividness rating, no adherence percentage, no weekly target:
-- the table holds what the athlete entered and nothing derived from it.
--
-- No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-athlete-mental-skills-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists, no alters, no drops.

create table if not exists pilot.athlete_mental_skill_entries (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  entry_id        uuid not null,
  athlete_id      text not null,
  kind            text not null
    constraint pilot_athlete_mental_skill_entries_kind_check
      check (kind in ('self_talk_cue', 'imagery_session')),
  cue_text        text null
    constraint pilot_athlete_mental_skill_entries_cue_text_check
      check (cue_text is null or (cue_text ~ '\S' and length(cue_text) <= 60)),
  cue_kind        text null
    constraint pilot_athlete_mental_skill_entries_cue_kind_check
      check (cue_kind is null or cue_kind in ('instructional', 'motivational')),
  minutes         integer null
    constraint pilot_athlete_mental_skill_entries_minutes_check
      check (minutes is null or minutes between 1 and 60),
  content_key     text null
    constraint pilot_athlete_mental_skill_entries_content_key_check
      check (content_key is null or content_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  logged_on       date not null,
  created_at      timestamptz not null default now(),
  primary key (organization_id, entry_id),
  -- Each kind carries exactly its own fields, so a row cannot be half of one
  -- kind and half of the other.
  constraint pilot_athlete_mental_skill_entries_shape_check check (
    (kind = 'self_talk_cue'
      and cue_text is not null and cue_kind is not null
      and minutes is null and content_key is null)
    or
    (kind = 'imagery_session'
      and cue_text is null and cue_kind is null
      and minutes is not null)
  ),
  constraint pilot_athlete_mental_skill_entries_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

create index if not exists idx_athlete_mental_skill_entries_athlete
  on pilot.athlete_mental_skill_entries(organization_id, athlete_id, kind, created_at desc);
