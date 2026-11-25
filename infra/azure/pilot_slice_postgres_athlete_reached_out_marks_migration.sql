-- The "reached out" mark on the "who has stopped coming" page
-- (pilot.athlete_reached_out_marks): lane W4-6, PR SC-3a-1 (the table; its
-- module and routes are SC-3a-2, the button on the page SC-3b).
--
-- WHY. Jason's ruling OW27-33 B (OD-2026-11-21-006): the stopped-coming page
-- lists people, opens the athlete, "plus mark 'reached out'", so two coaches
-- do not both reach out, or neither. Overwatch's W4-6 answer Q4 A (on #2163):
-- "who and when only, no free text, one current mark per athlete; taking it
-- back keeps the row and is audited". Shaped on rest marks (the plan, #2163).
--
-- WHO AND WHEN, NOTHING ELSE, FOR ANY AGE. The card's con was "a new record
-- about minors", so there is no free-text column: no note, channel or reason.
-- The only words are the role list below, and the two account columns must
-- name a real account (foreign keys), so they cannot hold a sentence either.
-- reachedOutMarksSchemaOwnership.test.ts pins the column list so a text column
-- cannot be added quietly.
--
-- ONE CURRENT MARK PER ATHLETE, EVERY TAKE-BACK KEPT. Each mark is its own row
-- (mark_id). The partial unique index below allows one uncleared mark per
-- athlete; a take-back sets cleared_at on that row and leaves it, and a later
-- mark is a new row. The audit stream (written by reachedOutMarks.ts, SC-3a-2)
-- records each change as well. The page shows the current mark only while it
-- is newer than the athlete's last day they came, so an athlete who came back
-- and stopped again starts clean without a write.
--
-- AN ACCOUNT'S PURGE CLEARS ITS ID HERE. A staff account id is often the
-- person's email address. Both account columns reference pilot.accounts ON
-- DELETE SET NULL (the pain-report reviewer's precedent, DR-25): the purge's
-- account delete is not held up, and the mark stays with its time and role
-- but no longer names the account. marked_by_account_id is nullable only for
-- that; the guard below refuses a mark that does not name who made it.
--
-- THE GUARD (trg_athlete_reached_out_marks_guard) holds the ruling at the
-- database, not only in the module: a new mark names who made it, starts
-- current, and takes the database's time; the one change a mark takes is a
-- take-back, once, naming who, at the database's time; nothing undoes a
-- take-back; and a mark is not deleted on its own (it goes with its athlete or
-- gym). The account foreign keys' own SET NULL is the one other update.
--
-- WHO MAY WRITE AND READ is the module's rule (SC-3a-2), not this file's:
-- coach, organization admin and admin with an active staff membership here,
-- for a live athlete of the gym. This file only refuses a mark made in any
-- other role, or for an athlete who is not on this gym's athlete table.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-reached-out-marks-migration.mjs) opens
-- the transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.athlete_reached_out_marks (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  mark_id                uuid not null,
  athlete_id             text not null,
  marked_by_account_id   text null,
  marked_by_role         text not null
    constraint pilot_athlete_reached_out_marks_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin')),
  marked_at              timestamptz not null default clock_timestamp(),
  cleared_at             timestamptz null,
  cleared_by_account_id  text null,
  primary key (organization_id, mark_id),
  -- Only a take-back names who took it back (and that name, too, goes when
  -- the account is deleted).
  constraint pilot_athlete_reached_out_marks_clear_check
    check (cleared_by_account_id is null or cleared_at is not null),
  constraint pilot_athlete_reached_out_marks_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint pilot_athlete_reached_out_marks_marked_by_fk
    foreign key (marked_by_account_id)
    references pilot.accounts(account_id)
    on delete set null,
  constraint pilot_athlete_reached_out_marks_cleared_by_fk
    foreign key (cleared_by_account_id)
    references pilot.accounts(account_id)
    on delete set null
);

-- One current (uncleared) mark per athlete. It is also the read path: the
-- gym's current marks, by organization.
create unique index if not exists uq_athlete_reached_out_marks_current
  on pilot.athlete_reached_out_marks(organization_id, athlete_id)
  where cleared_at is null;

create or replace function pilot.athlete_reached_out_marks_guard()
returns trigger
language plpgsql
as $athlete_reached_out_marks_guard$
begin
  if tg_op = 'DELETE' then
    -- Only as a consequence: the athlete's or the gym's delete, by cascade.
    if pg_trigger_depth() = 1 then
      raise exception 'REACHED_OUT_MARK_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_athlete_reached_out_marks_no_delete';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- (1) An account's delete: the foreign keys' own SET NULL, which runs this
    -- deeper than 1; only the account columns go to NULL, nothing else moves.
    if pg_trigger_depth() > 1
       and (new.marked_by_account_id is null or new.marked_by_account_id = old.marked_by_account_id)
       and (new.cleared_by_account_id is null or new.cleared_by_account_id = old.cleared_by_account_id)
       and to_jsonb(new) - array['marked_by_account_id', 'cleared_by_account_id']
         = to_jsonb(old) - array['marked_by_account_id', 'cleared_by_account_id'] then
      return new;
    end if;
    -- (2) The take-back, once, naming who, at the database's time; nothing
    -- else moves.
    if old.cleared_at is null and new.cleared_at is not null and new.cleared_by_account_id is not null
       and to_jsonb(new) - array['cleared_at', 'cleared_by_account_id']
         = to_jsonb(old) - array['cleared_at', 'cleared_by_account_id'] then
      new.cleared_at := greatest(clock_timestamp(), old.marked_at);
      return new;
    end if;
    raise exception 'REACHED_OUT_MARK_IS_NOT_CHANGED'
      using errcode = '23514', constraint = 'pilot_athlete_reached_out_marks_append_only';
  end if;
  -- INSERT: a current mark that names who made it, at the database's time.
  if new.marked_by_account_id is null then
    raise exception 'REACHED_OUT_MARK_NAMES_WHO'
      using errcode = '23514', constraint = 'pilot_athlete_reached_out_marks_names_who';
  end if;
  if new.cleared_at is not null or new.cleared_by_account_id is not null then
    raise exception 'REACHED_OUT_MARK_STARTS_CURRENT'
      using errcode = '23514', constraint = 'pilot_athlete_reached_out_marks_starts_current';
  end if;
  new.marked_at := clock_timestamp();
  return new;
end;
$athlete_reached_out_marks_guard$;

drop trigger if exists trg_athlete_reached_out_marks_guard on pilot.athlete_reached_out_marks;
create trigger trg_athlete_reached_out_marks_guard
  before insert or update or delete on pilot.athlete_reached_out_marks
  for each row execute function pilot.athlete_reached_out_marks_guard();

comment on table pilot.athlete_reached_out_marks is
  'Who on the staff marked that they reached out to an athlete on the stopped-coming list, and when (OW27-33 B; Overwatch W4-6 Q4 A). One current mark per athlete; a take-back keeps its row (cleared_at), and a later mark is a new row. No note or free text for any age. An account''s delete clears its id here. Staff only. Lane W4-6, SC-3a-1.';
