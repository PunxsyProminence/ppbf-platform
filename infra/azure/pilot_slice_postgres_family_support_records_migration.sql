-- Family support records: support the gym actually provided to a child's
-- family, recorded when it happened (PH-12, issue #1593; PH-13 reads it).
--
-- WHY A NEW TABLE (PH-12, gap check on #1542): the parent hub's
-- "Community Service Support" tile has no source. Membership standing and
-- scholarship already have one (pilot.program_memberships) and are reused,
-- not copied. pilot.activity_log's community_service rows are service hours a
-- person performed, a different fact. This is support given to a family:
-- transportation, equipment, a fee covered.
--
-- ONLY WHAT HAPPENED (PH-12 Q-A default B): a row says support was provided,
-- on a date that is not in the future (gym time). Eligibility, intentions and
-- plans are not recorded here, and nothing is inferred from attendance or
-- scholarship. No row means "none recorded", never "none provided".
--
-- WHO RECORDS (PH-12 Q-B default A): organization admins and admins, the same
-- seats that record memberships and scholarships. A row is born with its
-- recorder named; when that account is removed the record stays (set null).
--
-- NO STAFF-ONLY TEXT. There is no note column: what support_kind says is
-- what a family may later be shown (who reads what is PH-13's, and an owner
-- question on #1542), so nothing here needs stripping before it reaches them.
--
-- A RECORD IS NOT EDITED, AND NOTHING IS HARD-DELETED. The only change by
-- hand is retiring it, once and final -- a record entered in error is
-- retired and a correct one added. Retiring names who retired it
-- (retired_by_account_id) and the database stamps the time (now()), so the
-- trail of who decided what is kept. A direct DELETE is refused; one that
-- arrives as a cascade (its athlete or gym going) runs from inside another
-- trigger, so pg_trigger_depth() is above 1 and it goes through. Each refusal
-- is a 23514 with its own constraint name.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes.
-- Idempotent: if-not-exists throughout, the trigger function is create-or-
-- replace, and the trigger is dropped-and-created by name. No drops of any
-- table or data, no backfill. No begin;/commit; here on purpose, matching this
-- repo's runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-family-support-records-migration.mjs).

create table if not exists pilot.family_support_records (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  record_id uuid not null default gen_random_uuid(),
  athlete_id text not null,

  -- What was provided, in a few words a family can read.
  support_kind text not null,
  provided_on date not null,

  recorded_by_account_id text references pilot.accounts(account_id) on delete set null,
  recorded_by_role text not null,

  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by_account_id text references pilot.accounts(account_id) on delete set null,

  constraint pilot_family_support_records_pkey primary key (organization_id, record_id),

  constraint pilot_family_support_records_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,

  constraint pilot_family_support_records_kind_check
    check (char_length(btrim(support_kind)) between 1 and 200),
  constraint pilot_family_support_records_role_check
    check (recorded_by_role in ('organization_admin', 'admin'))
);

-- One child's records, most recent first.
create index if not exists idx_family_support_records_athlete
  on pilot.family_support_records(organization_id, athlete_id, provided_on desc);

create or replace function pilot.family_support_records_guard()
returns trigger
language plpgsql
as $family_support_records_guard$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'FAMILY_SUPPORT_RECORD_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_family_support_records_no_delete';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.retired_at is not null or new.retired_by_account_id is not null then
      raise exception 'FAMILY_SUPPORT_RECORD_IS_BORN_LIVE'
        using errcode = '23514', constraint = 'pilot_family_support_records_only_retired';
    end if;
    if new.recorded_by_account_id is null then
      raise exception 'FAMILY_SUPPORT_RECORD_NAMES_ITS_RECORDER'
        using errcode = '23514', constraint = 'pilot_family_support_records_recorder_named';
    end if;
    -- Provided, not planned: not after today in the gym's time zone.
    if new.provided_on > (now() at time zone 'America/New_York')::date then
      raise exception 'FAMILY_SUPPORT_RECORD_IS_NOT_IN_THE_FUTURE'
        using errcode = '23514', constraint = 'pilot_family_support_records_provided_past';
    end if;
    return new;
  end if;

  -- UPDATE. A cascade (an account going sets the recorder to null) runs from
  -- inside the foreign key's own trigger, so it is let through as is.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- By hand, the one change is retiring a live record, naming who did it.
  if old.retired_at is not null
     or new.retired_at is null
     or new.retired_by_account_id is null
     or (new.organization_id, new.record_id, new.athlete_id, new.support_kind, new.provided_on,
         new.recorded_by_account_id, new.recorded_by_role, new.created_at)
        is distinct from
        (old.organization_id, old.record_id, old.athlete_id, old.support_kind, old.provided_on,
         old.recorded_by_account_id, old.recorded_by_role, old.created_at) then
    raise exception 'FAMILY_SUPPORT_RECORD_IS_ONLY_RETIRED'
      using errcode = '23514', constraint = 'pilot_family_support_records_only_retired';
  end if;
  -- The time a record was retired is when it happened, not a value sent in.
  new.retired_at := now();
  return new;
end;
$family_support_records_guard$;

drop trigger if exists trg_family_support_records_guard on pilot.family_support_records;
create trigger trg_family_support_records_guard
  before insert or update or delete on pilot.family_support_records
  for each row execute function pilot.family_support_records_guard();
