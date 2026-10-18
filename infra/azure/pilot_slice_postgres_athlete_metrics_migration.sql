-- Athlete metrics, storage half (lane L60): the enjoyment tap after training
-- and the coach-entered standing height.
--
-- WHAT JASON RULED (OD-2026-10-17-026, "A: All three (Rec.)"): (a) a 1-5
-- enjoyment tap beside the end-of-session effort rating; (b) coach-entered
-- standing height about every 3 months, used only to show growth rate, no
-- maturity labels; (c) attendance from the class register, coaches only. (c)
-- needs no storage: it is read from pilot.attendance_reconciled. Overwatch's
-- GO to L60 (2026-10-17): "coaches only = coach + organization_admin + admin",
-- height in "its own staff-only table".
--
-- 1. pilot.sessions.enjoyment -- the athlete's own 1-5 answer to "how much did
--    you enjoy it", given at check-out beside the 0-10 effort rating
--    (pilot.sessions.rpe). NULL is "not answered" -- never 0, never a default.
--    The CHECK is the same range the application accepts.
--
-- 2. pilot.athlete_heights -- one row per standing-height reading, entered by
--    staff. WHY ITS OWN TABLE. Body mass is a SHADOW formula observation
--    ('body_weight'), and that store is athlete-writable through the generic
--    observations route and read by the athlete and their guardian;
--    pilot.assessments results reach the athlete and guardian through the
--    intake read (intake.ts, assessmentColumnsForReader). Height is
--    coach-only, so it is kept where only a staff read can reach it.
--
--    WHO WRITES. recorded_by_role is one of the three staff roles, and the
--    guard requires the recorder to hold that role in this gym through an
--    ACTIVE membership, on an active account that is not deleted -- the same
--    rule family_reply_reads, family_goals and family_support_records use for
--    their writers. An athlete, guardian or board seat cannot be the
--    recorder. A platform owner's seat carries the role platform_owner as
--    sign-in grants it (auth.ts), which the role check refuses; nothing here
--    reads pilot.accounts.is_platform_owner.
--
--    A READING IS NEVER CHANGED OR DELETED ROW BY ROW. A mistyped height is
--    corrected by a NEW row naming the one it replaces (supersedes_height_id),
--    as OD-2026-10-04-029 keeps the original of a corrected weight. The
--    reference is (organization_id, athlete_id, height_id), so a correction can
--    only replace a reading of the same athlete in the same gym, and each
--    reading is replaced at most once. The guard also requires the replaced
--    reading to exist already, so one multi-row INSERT cannot write two rows
--    that replace each other and leave no reading in force. The reading in
--    force is the one nothing supersedes. UPDATE is refused; a direct DELETE
--    is refused, and one that arrives as a cascade (the athlete or the gym
--    going, e.g. the retention purge deleting pilot.athletes) runs from inside
--    another trigger, so pg_trigger_depth() is above 1 and it goes through.
--    TRUNCATE, an administrator's statement that skips row triggers, is not
--    guarded here (as for family_reply_reads).
--
--    ONE SAVE, ONE ROW. request_key is unique per gym: the application derives
--    it from the save, so a retry after a lost reply lands on the row the
--    first attempt wrote instead of adding a second reading.
--
--    The bounds (50.0-250.0 cm, one decimal) refuse typing slips -- a value in
--    millimetres, a missing decimal point -- not people. A height typed in
--    inches (50-98) is inside the bounds and is NOT refused here; the
--    application labels the box in centimetres. No predicted maturity, growth
--    category or label is stored, here or anywhere.
--
-- DEPENDS ON pilot.organizations, pilot.accounts,
-- pilot.organization_memberships, pilot.athletes and pilot.sessions.
-- Additive only: no drop of a table, column or data, no backfill, no altered
-- value. Idempotent: if-not-exists throughout, catalog-guarded constraint,
-- create-or-replace function, trigger dropped-and-created by name. No
-- begin;/commit; here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-metrics-migration.mjs) opens the
-- transaction itself.

-- ---------------------------------------------------------------------------
-- 1. ENJOYMENT.

alter table pilot.sessions
  add column if not exists enjoyment integer null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_sessions_enjoyment_range'
      and conrelid = to_regclass('pilot.sessions')
  ) then
    alter table pilot.sessions add constraint pilot_sessions_enjoyment_range
      check (enjoyment is null or enjoyment between 1 and 5);
  end if;
end
$$;

comment on column pilot.sessions.enjoyment is
  'The athlete''s own answer at check-out to how much they enjoyed the session, 1-5, higher is more. NULL means not answered, never 0, never a default (OD-2026-10-17-026 (a)).';

-- ---------------------------------------------------------------------------
-- 2. STANDING HEIGHT.

create table if not exists pilot.athlete_heights (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  height_id              uuid not null,
  athlete_id             text not null,
  measured_on            date not null,
  height_cm              numeric(4,1) not null,
  -- An id string, not a foreign key: a reading is a fact about the athlete
  -- and stays when the staff account that typed it is removed.
  recorded_by_account_id text not null,
  recorded_by_role       text not null,
  request_key            text not null,
  supersedes_height_id   uuid null,
  recorded_at            timestamptz not null default clock_timestamp(),

  constraint pilot_athlete_heights_pkey primary key (organization_id, height_id),
  -- The target of the correction reference below: same gym, same athlete.
  constraint pilot_athlete_heights_athlete_height_key unique (organization_id, athlete_id, height_id),
  constraint pilot_athlete_heights_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_athlete_heights_supersedes_fk
    foreign key (organization_id, athlete_id, supersedes_height_id)
    references pilot.athlete_heights(organization_id, athlete_id, height_id) on delete cascade,
  -- Each reading is replaced at most once (NULLs are distinct, so any number
  -- of first readings coexist).
  constraint pilot_athlete_heights_one_correction unique (organization_id, supersedes_height_id),
  constraint pilot_athlete_heights_request_key_unique unique (organization_id, request_key),

  constraint pilot_athlete_heights_cm_range check (height_cm between 50.0 and 250.0),
  constraint pilot_athlete_heights_role_check
    check (recorded_by_role in ('coach', 'organization_admin', 'admin')),
  constraint pilot_athlete_heights_request_key_check
    check (length(btrim(request_key)) between 1 and 200),
  constraint pilot_athlete_heights_not_self_check
    check (supersedes_height_id is null or supersedes_height_id <> height_id),
  constraint pilot_athlete_heights_measured_on_check check (measured_on >= date '2000-01-01')
);

-- One athlete's readings, newest first.
create index if not exists idx_athlete_heights_athlete_measured
  on pilot.athlete_heights(organization_id, athlete_id, measured_on desc);

create or replace function pilot.athlete_heights_guard()
returns trigger
language plpgsql
as $athlete_heights_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'ATHLETE_HEIGHT_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_athlete_heights_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Missing keys are left to NOT NULL, and a role outside the list to the
    -- role check, so each is reported by its own name.
    if new.organization_id is null or new.recorded_by_account_id is null
       or new.recorded_by_role is null
       or new.recorded_by_role not in ('coach', 'organization_admin', 'admin') then
      return new;
    end if;
    -- A correction replaces a reading that is already there (rows written
    -- earlier in the same statement count; later ones do not), so no two rows
    -- can replace each other. Reported under the reference's own name.
    if new.supersedes_height_id is not null and not exists (
      select 1 from pilot.athlete_heights p
       where p.organization_id = new.organization_id and p.athlete_id = new.athlete_id
         and p.height_id = new.supersedes_height_id
    ) then
      raise exception 'ATHLETE_HEIGHT_CORRECTS_AN_EXISTING_READING'
        using errcode = '23503', constraint = 'pilot_athlete_heights_supersedes_fk';
    end if;
    if not exists (
      select 1 from pilot.organization_memberships om
        join pilot.accounts a on a.account_id = om.account_id
       where om.account_id = new.recorded_by_account_id and om.organization_id = new.organization_id
         and om.active_flag and om.role = new.recorded_by_role
         and a.active_flag and a.deleted_at is null
    ) then
      raise exception 'ATHLETE_HEIGHT_RECORDER_OF_THIS_GYM'
        using errcode = '23514', constraint = 'pilot_athlete_heights_recorder_of_this_gym';
    end if;
    return new;
  end if;

  -- UPDATE: never. A correction is a new row.
  raise exception 'ATHLETE_HEIGHT_IS_NOT_CHANGED'
    using errcode = '23514', constraint = 'pilot_athlete_heights_append_only';
end;
$athlete_heights_guard$;

drop trigger if exists trg_athlete_heights_guard on pilot.athlete_heights;
create trigger trg_athlete_heights_guard
  before insert or update or delete on pilot.athlete_heights
  for each row execute function pilot.athlete_heights_guard();

comment on table pilot.athlete_heights is
  'Staff-entered standing height, one row per reading, append-only; a correction is a new row naming the reading it replaces (supersedes_height_id) and the original stays. Coach-only: read by staff of the gym, never by the athlete, a guardian, the board or the platform owner. Used only for growth rate; no maturity labels (OD-2026-10-17-026 (b)).';
comment on column pilot.athlete_heights.request_key is
  'Derived by the application from the save, unique per gym, so a retried save lands on the first attempt''s row instead of adding a reading.';
