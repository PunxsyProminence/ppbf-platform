-- Athlete rest/away marks (pilot.athlete_rest_marks): lane R6-b1, owner
-- ruling OD-2026-11-17-004 (OW25-30 A): "A recorded rest or away mark (no
-- health reason asked for minors), a per-week share of rated sessions, and a
-- ratio that stays silent otherwise; no imputed numbers on screen."
--
-- WHY. Rule 6 (the coach's "Training load jumped" prompt) reads session RPE x
-- minutes. A week with nothing logged is skipped as unknown, so the app cannot
-- tell "didn't train" from "didn't log it". This table is the recorded half:
-- a coach marks days on which an athlete rested or was away, so a quiet week
-- becomes a known value instead of a guess. Nothing here changes Rule 6; the
-- rated share and the ratio's silence are lane R6-b2.
--
-- NO REASON, NOTE OR FREE TEXT, FOR ANY AGE. The ruling says no health reason
-- is asked for minors. The strongest form of that is a table with nowhere to
-- type one: the only words are the two fixed kinds below. Health status has
-- its own governed records (athlete_injuries, training_holds, medical
-- restrictions); this is not one of them. restMarksSchemaOwnership.test.ts
-- pins the column list so a text column cannot be added quietly.
--
-- ONE ROW IS ONE RANGE OF GYM DAYS (first_day..last_day, both inclusive, the
-- gym's calendar dates as pilot.sessions.date is). 'rest' and 'away' are
-- counted the same way by the load rule; only the word differs. A range is at
-- most 35 days, the five 7-day weeks the load rule reads.
--
-- CLEARING KEEPS THE ROW. Undo sets cleared_at and cleared_by_account_id;
-- reads skip cleared rows; the audit stream holds the history.
--
-- WHO is the module's rule (restMarks.ts): staff with an active membership
-- here who reach the athlete through assertActorCanAccessAthlete, in the
-- roles that module names. Athletes, parents and the board read nothing here.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-rest-marks-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.athlete_rest_marks (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  mark_id                uuid not null,
  athlete_id             text not null,
  kind                   text not null
    constraint pilot_athlete_rest_marks_kind_check check (kind in ('rest', 'away')),
  first_day              date not null,
  last_day               date not null,
  marked_by_account_id   text not null,
  marked_by_role         text not null
    constraint pilot_athlete_rest_marks_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin')),
  marked_at              timestamptz not null default clock_timestamp(),
  cleared_at             timestamptz null,
  cleared_by_account_id  text null,
  primary key (organization_id, mark_id),
  -- A range runs forward and covers at most 35 gym days.
  constraint pilot_athlete_rest_marks_range_check
    check (last_day >= first_day and last_day - first_day <= 34),
  -- A clear names who cleared it, and only a clear does.
  constraint pilot_athlete_rest_marks_clear_check
    check ((cleared_at is null) = (cleared_by_account_id is null)),
  constraint pilot_athlete_rest_marks_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

-- The read path: one athlete's live marks over a date window.
create index if not exists idx_athlete_rest_marks_athlete_days
  on pilot.athlete_rest_marks(organization_id, athlete_id, first_day, last_day)
  where cleared_at is null;

-- One live mark per exact range and kind: a second tap on the same week's
-- "Rest" finds the first mark instead of stacking a copy.
create unique index if not exists uq_athlete_rest_marks_live_range
  on pilot.athlete_rest_marks(organization_id, athlete_id, kind, first_day, last_day)
  where cleared_at is null;

comment on table pilot.athlete_rest_marks is
  'Coach-recorded rest or away days for one athlete (a range of gym days). No reason, note or free text for any age (OD-2026-11-17-004: no health reason asked for minors). Cleared marks keep their row (cleared_at). Staff only. Lane R6-b1.';
