-- A cancelled class's register marks stop counting on the per-day attendance
-- view (lane LV).
--
-- THE RULING. Jason, 2026-10-22 (OD-2026-10-22-001): "then classes need to be
-- able to be canceled". Overwatch applied the detail under OD-2026-10-21-005:
-- a cancelled class's attendance stops counting, with every row kept and staff
-- still able to see them. Lane LC (#1825) made the class-mark readers skip a
-- cancelled class; this is the one reader that needed a migration, because
-- pilot.attendance_reconciled carries no class id and so no reader can filter
-- it from outside.
--
-- THE CHANGE. pilot.attendance_reconciled is redefined exactly as
-- pilot_slice_postgres_attendance_precedence_migration.sql left it, except
-- that the class-marks branch (rank 2) now reads only marks on a class whose
-- status is not 'cancelled'. scheduler_classes.status is NOT NULL and one of
-- 'open' / 'full' / 'cancelled' (scheduler-tables migration), so "<>" leaves
-- no row undecided. The activity_log branch (rank 1) and the legacy branch
-- (rank 3) are character-for-character the same, and so are the column list,
-- its order and its types, which `create or replace view` requires.
--
-- WHAT A CANCELLED CLASS NOW DOES TO AN ATHLETE-DAY. The filter sits BEFORE
-- the day is collapsed, so a cancelled class's marks are simply not there:
--   - the day's status and class_marks_that_day come from the classes that
--     were held that day only;
--   - a day whose ONLY class marks were on a cancelled class has no rank-2 row
--     at all, so precedence falls through as it always has: an activity_log
--     boxing row wins if there is one (it already won before), else a legacy
--     pilot.attendance row for that day wins, else the athlete-day is not in
--     the view (no mark on record, which every reader already treats as "not
--     marked", never as absent);
--   - contributing_sources stops counting the scheduler for that day, because
--     the cancelled class no longer said anything.
-- That fall-through is deliberate and kept: a cancelled class is treated as
-- if its register had never been taken, not as a statement that the athlete
-- was absent.
--
-- NOTHING IS DELETED OR ALTERED. No table is touched. Every
-- pilot.scheduler_attendance row stays, and staff still see them: the
-- attendance list on /schedule (GET /api/pilot/scheduler, staff branches) and
-- the by-class report on /admin/attendance, which lists the class as
-- cancelled. Un-cancelling a class (a status update; there is no button for
-- it) brings its marks straight back, because the view is computed on read.
--
-- GRANTS AND OWNERSHIP. `create or replace view` keeps the view's owner, its
-- privileges and its oid. No migration in infra/azure grants on this view;
-- nothing here grants or revokes either.
--
-- ORDER. Runs after attendance-precedence in the `all` list, which re-runs
-- attendance-precedence (the old definition) earlier in every dispatch. So:
-- a completed `all` run ends with this definition; an `all` run that stops
-- between the two, or attendance-precedence dispatched on its own, leaves the
-- old definition (cancelled marks counted again) until this one is run again;
-- and during a completed run the old definition is live for the minutes
-- between the two steps. pilot-verify-schema checks only that the view
-- exists, so it cannot tell the two definitions apart; this runner's
-- readiness can.
--
-- Idempotent: one `create or replace view` and one `comment on view`. Re-running
-- it is a no-op.

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
  --    A cancelled class's marks are left out before the day is collapsed
  --    (OD-2026-10-22-001); the rows stay in pilot.scheduler_attendance.
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
  where sc.status <> 'cancelled'
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
  'CT-13 system of record for athlete-day participation. Exactly one row per (organization_id, athlete_id, attendance_date). Precedence: activity_log (boxing_training) > scheduler_attendance (collapsed to gym-local day) > attendance (legacy). Sources are never summed -- the highest available one wins outright. Count rows here for participation figures; never sum the underlying tables. class_marks_that_day carries how many class-level marks sat behind the day, for detail only. Marks on a cancelled class (scheduler_classes.status = ''cancelled'') are not read (OD-2026-10-22-001); their rows stay in pilot.scheduler_attendance.';
