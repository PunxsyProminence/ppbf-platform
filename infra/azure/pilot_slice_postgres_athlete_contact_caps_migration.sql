-- Athlete contact caps (pilot.athlete_contact_caps): the limits a COACH sets
-- for one athlete's sparring -- the highest contact stage they may spar at,
-- and the most hard or open sparring sessions they may do in any 7 days.
-- The count has no upper bound: any whole number a coach chooses is stored
-- (zero means none); the app does not decide what is too many.
--
-- THESE ARE COACH-SET DATA, NOT AN APP RECOMMENDATION. The sparring-exposure
-- migration refuses "no recommended limit", and that refusal stands: nothing
-- here proposes, computes, defaults or scores a limit. Every value in this
-- table was typed by a coach or organization admin for one named athlete
-- (minors' limits are coach-set data; missing -> ask, never invented by the
-- app). An athlete with no row, or whose newest row has both limits empty,
-- has NO CAP SET, and the app says exactly that rather than inventing one.
--
-- WARN, NEVER BLOCK (Jason, 2026-10-04, in the lane session: "Warn only").
-- A sparring entry above the cap still saves; the entry screen shows the cap
-- and a warning, and the coach decides. Nothing in this table gates a write.
--
-- APPEND-ONLY. Setting, changing or clearing a cap inserts a new row; the
-- newest row per athlete is the cap in force. So the history of who allowed
-- what, and when, is the table itself -- a child's contact limit is never
-- overwritten silently. Clearing a cap is a row with both limits null.
--
-- THE LADDER is the contact_level vocabulary drills, templates and cohorts
-- already use (contentImport/vocabularies.ts): none < light_technical <
-- conditioned < controlled_sparring < open_sparring. The order is the order
-- of that list.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-contact-caps-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.athlete_contact_caps (
  organization_id                   text not null references pilot.organizations(organization_id) on delete cascade,
  cap_id                            uuid not null,
  athlete_id                        text not null,
  highest_allowed_stage             text null
    constraint pilot_athlete_contact_caps_stage_check check (
      highest_allowed_stage is null
      or highest_allowed_stage in ('none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring')
    ),
  max_hard_open_sessions_per_7_days integer null
    constraint pilot_athlete_contact_caps_sessions_check check (
      max_hard_open_sessions_per_7_days is null
      or max_hard_open_sessions_per_7_days >= 0
    ),
  note                              text not null default ''
    constraint pilot_athlete_contact_caps_note_check check (length(note) <= 1000),
  set_by_account_id                 text not null,
  set_by_role                       text not null
    constraint pilot_athlete_contact_caps_role_check check (set_by_role in ('coach', 'organization_admin', 'admin')),
  set_at                            timestamptz not null default clock_timestamp(),
  -- Insertion order. "Newest" is decided by this, never by a timestamp: two
  -- writes in the same clock tick cannot tie, so the cap in force is always
  -- the last one written.
  cap_seq                           bigint generated always as identity,
  primary key (organization_id, cap_id),
  constraint pilot_athlete_contact_caps_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

-- The cap in force is the newest row per athlete; this is the read path.
create index if not exists idx_athlete_contact_caps_athlete_seq
  on pilot.athlete_contact_caps(organization_id, athlete_id, cap_seq desc);
