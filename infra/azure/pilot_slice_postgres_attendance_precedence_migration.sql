-- Attendance precedence (CT-13). The written half of this decision is
-- docs/current/ATTENDANCE_PRECEDENCE.md; this file is the enforced half.
--
-- THE PROBLEM. Three attendance-shaped tables exist and nothing declared
-- which one is authoritative:
--
--   pilot.attendance           athlete-day, written only by the intake case
--                              flow, and -- the actual defect -- carrying NO
--                              unique constraint of any kind. Its primary key
--                              is (organization_id, attendance_id) where
--                              attendance_id is a fresh uuid per insert, so
--                              the same athlete can be marked present on the
--                              same day without limit and nothing refuses it.
--                              Its status column is unconstrained free text.
--   pilot.scheduler_attendance athlete-CLASS, properly constrained, written by
--                              the live check-in path. An athlete in two
--                              classes on one day legitimately has two rows.
--   pilot.activity_log         person-occurrence across every domain the gym
--                              tracks, uniquely constrained per occurrence,
--                              carrying capture_method and recorded_by_role.
--
-- No shipped query today reads more than one of them, so nothing reported to a
-- funder is currently double-counted. That was luck, not design: the moment
-- the KPI layer sums a class-grain table and a day-grain table, participation
-- inflates by however many athletes attend more than one class a day.
--
-- THE DECISION. pilot.activity_log is the athlete-day system of record.
-- pilot.scheduler_attendance is the class-session detail feeding it.
-- pilot.attendance is frozen legacy history: readable, never authoritative.
--
-- WHY NOT pilot.attendance, which CT-13 itself recommended. A table that
-- permits unlimited duplicate athlete-days cannot be the authority on how many
-- athlete-days occurred; it records no capture evidence (who marked a child
-- present, and how, is safeguarding evidence, not metadata); its status
-- vocabulary is unconstrained; and the live floor does not write to it. This
-- also follows owner policy already recorded in docs/current/ACTIVE_WORK.md
-- under BACKLOG-activity-log-backfill: "pilot.activity_log is go-forward
-- evidence."
--
-- WHY NO UNIQUE CONSTRAINT IS ADDED TO pilot.attendance. Adding a unique index
-- to a table that may already hold duplicate athlete-days fails at apply time
-- against real data, and the only way to "make it pass" is to delete rows
-- describing real children. The view below de-duplicates on READ. Every
-- underlying row stays exactly where it is.
--
-- Idempotent: create or replace view, comments only, no drops of any table, no
-- destructive alters. Nothing here writes or deletes a single row.

-- ---------------------------------------------------------------------------
-- Precedence, recorded on the objects themselves so a person reading the
-- schema in psql learns it without finding the markdown.
-- ---------------------------------------------------------------------------

comment on table pilot.attendance is
  'FROZEN LEGACY (CT-13). Not authoritative for participation. No unique constraint exists on (organization_id, athlete_id, attendance_date), so this table may hold duplicate athlete-days; status is unconstrained free text. Written only by the intake case flow. Read participation through pilot.attendance_reconciled, never by counting this table directly. Retained because it holds real records.';

comment on table pilot.scheduler_attendance is
  'CLASS-SESSION DETAIL (CT-13). Authoritative for "was this athlete marked for this class", NOT for athlete-day participation -- an athlete in two classes on one day correctly has two rows here, and summing them as days double-counts. Roll up through pilot.attendance_reconciled for day-grain figures.';

-- ---------------------------------------------------------------------------
-- pilot.attendance_reconciled
--
-- Exactly one row per (organization_id, athlete_id, attendance_date), whatever
-- the three sources hold. Highest available source wins outright; lower
-- sources are never ADDED to it. That "never added" is the whole property this
-- view exists to guarantee.
--
-- TIMEZONE. scheduler_attendance has no date column of its own; the day comes
-- from scheduler_classes.start_at, which is timestamptz. It is converted to the
-- gym's own zone before ::date, because taking ::date in UTC pushes every class
-- starting after 8pm ET onto the following calendar day and silently
-- misattributes it. Same rule gymTimeDrift.test.ts enforces on the front end.
-- ---------------------------------------------------------------------------

create or replace view pilot.attendance_reconciled as
with unified as (
  -- 1. Highest precedence: the go-forward evidence stream, boxing rows only.
  --    Other activity domains (schoolwork, community service) are real hours
  --    but they are not gym attendance and must not enter a participation
  --    figure through this door.
  select
    al.organization_id,
    al.athlete_id,
    al.occurred_on                       as attendance_date,
    al.attendance_status                 as status,
    'activity_log'::text                 as source,
    1                                    as precedence_rank,
    0                                    as class_marks_that_day
  from pilot.activity_log al
  where al.athlete_id is not null
    and al.activity_domain = 'boxing_training'

  union all

  -- 2. Class marks, collapsed to a day. An athlete marked present in any class
  --    that day counts as present for the day; 'excused' only wins the day if
  --    there was no present and no absent mark. count(*) here is the number of
  --    CLASS marks, carried as detail -- it is never the participation number.
  select
    sa.organization_id,
    sa.athlete_id,
    (sc.start_at at time zone 'America/New_York')::date as attendance_date,
    case
      when count(*) filter (where sa.status = 'present') > 0 then 'present'
      when count(*) filter (where sa.status = 'absent')  > 0 then 'absent'
      else 'excused'
    end                                  as status,
    'scheduler_attendance'::text         as source,
    2                                    as precedence_rank,
    count(*)::int                        as class_marks_that_day
  from pilot.scheduler_attendance sa
  join pilot.scheduler_classes sc
    on sc.organization_id = sa.organization_id
   and sc.class_id = sa.class_id
  group by sa.organization_id, sa.athlete_id,
           (sc.start_at at time zone 'America/New_York')::date

  union all

  -- 3. Legacy. Deliberately collapsed with min()/group by rather than selected
  --    raw: this table can hold several rows for one athlete-day, and feeding
  --    them through unaggregated would let the duplicate reappear as the very
  --    double-count this view exists to prevent.
  --
  --    'late' is normalised to 'present' -- it is a value only this table can
  --    express, and a late arrival is a day attended. Anything outside the
  --    known vocabulary becomes 'absent' rather than being invented into a
  --    presence claim.
  select
    a.organization_id,
    a.athlete_id,
    a.attendance_date,
    case
      when count(*) filter (
        where lower(btrim(a.status)) in ('present', 'late')
      ) > 0 then 'present'
      when count(*) filter (
        where lower(btrim(a.status)) = 'excused'
      ) > 0 then 'excused'
      else 'absent'
    end                                  as status,
    'attendance'::text                   as source,
    3                                    as precedence_rank,
    0                                    as class_marks_that_day
  from pilot.attendance a
  group by a.organization_id, a.athlete_id, a.attendance_date
)
select distinct on (organization_id, athlete_id, attendance_date)
  organization_id,
  athlete_id,
  attendance_date,
  status,
  source,
  class_marks_that_day,
  -- How many of the three sources had anything to say about this athlete-day.
  -- Exposed so disagreement is visible instead of silently resolved: a KPI
  -- reader can see that two sources spoke and only the winner was counted.
  count(*) over (
    partition by organization_id, athlete_id, attendance_date
  )::int as contributing_sources
from unified
order by organization_id, athlete_id, attendance_date, precedence_rank;

comment on view pilot.attendance_reconciled is
  'CT-13 system of record for athlete-day participation. Exactly one row per (organization_id, athlete_id, attendance_date). Precedence: activity_log (boxing_training) > scheduler_attendance (collapsed to gym-local day) > attendance (legacy). Sources are never summed -- the highest available one wins outright. Count rows here for participation figures; never sum the underlying tables. class_marks_that_day carries how many class-level marks sat behind the day, for detail only.';
