-- Athlete minor limits (pilot.athlete_minor_limits): the per-athlete limits a
-- COACH sets for a minor, stored as DATA so the AI and screens can read them
-- (OD-2026-10-06-024 ruling 2, Jason: "Yes, build it (Recommended)"; the
-- option text: "coaches decide the numbers"). OD-2026-09-21-001 items 2-4:
-- limits are data, not constants in code and not values the AI chooses; a
-- missing limit means the AI ASKS, it does not fill in a default.
--
-- THREE LIMIT TYPES HERE. Contact level is NOT one of them on purpose: it
-- already has coach-set storage for every athlete in
-- pilot.athlete_contact_caps (#1178), and a second column for one child's
-- contact limit would be two sources of truth. Readers take contact level
-- from the caps table.
--
--   heat_exposure_minutes_per_session   value_number, unit 'minutes'
--   weight_cut_max_percent_body_weight  value_number, unit 'percent_body_weight'
--   supervision                         value_text,   unit 'text' -- what the
--                                       coach requires, in the coach's words
--
-- THESE ARE COACH-SET DATA, NOT AN APP RECOMMENDATION. Nothing here proposes,
-- computes, defaults or scores a limit. Every row was typed by a coach or
-- organization admin for one named athlete. An athlete with no row for a
-- type, or whose newest row for it is cleared, has NO LIMIT SET for that type,
-- and the app says exactly that rather than inventing one.
--
-- WHO IS A MINOR is not stored here. pilot.athletes.dob decides it at read
-- time through isMinor() (apps/web/src/server/pilot/wallDisplay.ts), where an
-- unknown date of birth counts as a minor. A coach may record these limits
-- for any athlete they reach; reads label the athlete minor or adult.
--
-- APPEND-ONLY, ONE ROW PER WRITE OF ONE TYPE. Setting, changing or clearing a
-- limit inserts a new row; the newest row per (athlete, limit_type) is the
-- limit in force. So the history of who allowed what, and when, is the table
-- itself -- a child's limit is never overwritten silently. Clearing a type is
-- a row with both values null.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-minor-limits-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.athlete_minor_limits (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  limit_id           uuid not null,
  athlete_id         text not null,
  limit_type         text not null
    constraint pilot_athlete_minor_limits_type_check check (
      limit_type in ('heat_exposure_minutes_per_session', 'weight_cut_max_percent_body_weight', 'supervision')
    ),
  -- The number the coach typed, for the two numeric types. Null = cleared.
  value_number       numeric(8,2) null
    constraint pilot_athlete_minor_limits_number_check check (
      value_number is null or value_number >= 0
    ),
  -- The coach's words, for supervision. Null = cleared; never blank.
  value_text         text null
    constraint pilot_athlete_minor_limits_text_check check (
      value_text is null or (length(btrim(value_text)) > 0 and length(value_text) <= 500)
    ),
  unit               text not null
    constraint pilot_athlete_minor_limits_unit_check check (
      unit in ('minutes', 'percent_body_weight', 'text')
    ),
  note               text not null default ''
    constraint pilot_athlete_minor_limits_note_check check (length(note) <= 1000),
  set_by_account_id  text not null,
  set_by_role        text not null
    constraint pilot_athlete_minor_limits_role_check check (set_by_role in ('coach', 'organization_admin', 'admin')),
  set_at             timestamptz not null default clock_timestamp(),
  -- Insertion order. "Newest" is decided by this, never by a timestamp: two
  -- writes in the same clock tick cannot tie, so the limit in force is always
  -- the last one written.
  limit_seq          bigint generated always as identity,
  primary key (organization_id, limit_id),
  constraint pilot_athlete_minor_limits_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  -- Each type carries exactly its own kind of value in its own unit. A
  -- percentage cannot exceed 100; minutes have no app-set ceiling.
  constraint pilot_athlete_minor_limits_shape_check check (
    (limit_type = 'heat_exposure_minutes_per_session'
       and unit = 'minutes' and value_text is null)
    or (limit_type = 'weight_cut_max_percent_body_weight'
       and unit = 'percent_body_weight' and value_text is null
       and (value_number is null or value_number <= 100))
    or (limit_type = 'supervision'
       and unit = 'text' and value_number is null)
  )
);

-- The limit in force is the newest row per athlete and type; this is the read path.
create index if not exists idx_athlete_minor_limits_athlete_type_seq
  on pilot.athlete_minor_limits(organization_id, athlete_id, limit_type, limit_seq desc);

comment on table pilot.athlete_minor_limits is
  'Coach-set per-athlete limits for minors (heat minutes per session, max % body weight cut, supervision), append-only; newest row per type is in force; null values clear. Contact level lives in pilot.athlete_contact_caps. OD-2026-10-06-024 ruling 2.';
