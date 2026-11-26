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
-- The only words are two fixed lists below, the role and how a mark stopped
-- being current (cleared_kind), and the two account columns must name a real
-- account (foreign keys), so they cannot hold a sentence either.
-- reachedOutMarksSchemaOwnership.test.ts pins the column list so a text column
-- cannot be added quietly.
--
-- ONE CURRENT MARK PER ATHLETE, EVERY ENDED MARK KEPT. Each mark is its own row
-- (mark_id). The partial unique index below allows one uncleared mark per
-- athlete. A mark stops being current in one of two ways, and its row stays:
-- cleared_at, who ended it (cleared_by_account_id) and how (cleared_kind).
--   'taken_back': a coach or admin took the mark back (Q4 A).
--   'replaced':   the athlete came back and then stopped again, so the mark
--                 was for an earlier absence; a coach marking the new absence
--                 ends it and inserts the new mark in the same transaction
--                 (reachedOutMarks.ts, SC-3a-2, decides that a mark is stale:
--                 not newer than the athlete's last day they came, the page
--                 rule in the plan, #2163 section 4). The new row names who.
-- Without the second way the stale mark would stay current and this index
-- would refuse the new absence's mark (Codex, #2176). An athlete who comes
-- back and keeps coming keeps their last mark, current, until it is taken back
-- or replaced; the page (SC-3b, not built yet) is to show it only while it is
-- newer than their last day they came. The fixed word follows the athlete
-- pathway's end_reason 'replaced', but this table does not link an ended mark
-- to the mark that replaced it (the pathway holds that link with a deferred
-- self-reference).
-- So this file checks neither that a 'replaced' mark was stale (the database
-- cannot see the athlete's last day they came) nor that a new mark followed
-- it: the module ends the old mark and inserts the new one in one
-- transaction, and the audit stream (written by reachedOutMarks.ts, SC-3a-2)
-- records each change.
--
-- STAFF IDS STAY UNTIL THE ATHLETE GOES; A DELETED ACCOUNT'S ID GOES AT ONCE.
-- A staff account id is often the person's email address. Only staff mark or
-- end a mark, and no job deletes a staff account: the retention purge deletes
-- only role 'parent' accounts (pilot-cleanup-deleted-data.mjs), and
-- DATA_RETENTION.md says a staff account is never hard-deleted. So the ids of
-- who marked and who ended a mark, a replaced mark's ender included, stay on
-- the row until the athlete row is purged and the mark goes with it. Both
-- account columns reference pilot.accounts ON DELETE SET NULL (the
-- pain-report reviewer's precedent, DR-25), so an account delete that does
-- happen (an account the purge deletes, or a staff deletion added later) is
-- not held up: the mark stays with its time, role and kind but no longer
-- names the account. marked_by_account_id is nullable only for that; the
-- guard below refuses a mark that does not name who made it.
--
-- THE GUARD (trg_athlete_reached_out_marks_guard) holds the ruling at the
-- database, not only in the module: a new mark names who made it, starts
-- current, and takes the database's time; the one change a mark takes is its
-- end (a take-back or a replacement), once, naming who and how, at the
-- database's time; nothing undoes or relabels an end; and a mark is not
-- deleted on its own (it goes with its athlete or gym). The account foreign
-- keys' own SET NULL is the one other update. The runner refuses any other
-- trigger or rule on this table. Two gaps, neither reached by app code:
-- TRUNCATE, a statement-level command, is not guarded (as on the behaviour
-- windows; pg suites truncate pilot.organizations and pilot.accounts with
-- cascade, and no app code truncates a pilot table). And the guard knows an
-- athlete or account is gone only by its key: a statement that renames the
-- athlete's or account's key and, in the same statement, deletes the mark or
-- clears the name (a writable CTE, or a trigger on pilot.athletes or
-- pilot.accounts) gets past it (reviewer G, #2176). Holding that would mean
-- refusing key changes on those tables, which this file does not touch.
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
  cleared_kind           text null
    constraint pilot_athlete_reached_out_marks_cleared_kind_check check (cleared_kind in ('taken_back', 'replaced')),
  primary key (organization_id, mark_id),
  -- Only an ended mark names who ended it (and that name, too, goes when the
  -- account is deleted), and an ended mark, and only an ended mark, says how.
  constraint pilot_athlete_reached_out_marks_clear_check
    check ((cleared_by_account_id is null or cleared_at is not null)
           and (cleared_at is null) = (cleared_kind is null)),
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
  -- Each exception is tested on the data, not on the trigger depth, so a
  -- write from another table's trigger is held the same way (except the
  -- same-statement key rename named in the header).
  if tg_op = 'DELETE' then
    -- Only once the mark's athlete row is gone: the athlete's delete, or the
    -- gym's (which needs its athletes gone first), by cascade.
    if exists (
      select 1 from pilot.athletes a
       where a.organization_id = old.organization_id and a.athlete_id = old.athlete_id
    ) then
      raise exception 'REACHED_OUT_MARK_IS_NOT_DELETED'
        using errcode = '23514', constraint = 'pilot_athlete_reached_out_marks_no_delete';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- (1) An account's delete: the foreign keys' SET NULL. A name goes NULL only
    -- once its account row is gone; nothing else moves.
    if (new.marked_by_account_id is not distinct from old.marked_by_account_id
        or (new.marked_by_account_id is null
            and not exists (select 1 from pilot.accounts x where x.account_id = old.marked_by_account_id)))
       and (new.cleared_by_account_id is not distinct from old.cleared_by_account_id
        or (new.cleared_by_account_id is null
            and not exists (select 1 from pilot.accounts x where x.account_id = old.cleared_by_account_id)))
       and to_jsonb(new) - array['marked_by_account_id', 'cleared_by_account_id']
         = to_jsonb(old) - array['marked_by_account_id', 'cleared_by_account_id'] then
      return new;
    end if;
    -- (2) The end (a take-back or a replacement), once, naming who and how,
    -- at the database's time; nothing else moves. The kind's CHECK refuses any
    -- other word.
    if old.cleared_at is null and new.cleared_at is not null and new.cleared_by_account_id is not null
       and new.cleared_kind is not null
       and to_jsonb(new) - array['cleared_at', 'cleared_by_account_id', 'cleared_kind']
         = to_jsonb(old) - array['cleared_at', 'cleared_by_account_id', 'cleared_kind'] then
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
  if new.cleared_at is not null or new.cleared_by_account_id is not null or new.cleared_kind is not null then
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
  'Who on the staff marked that they reached out to an athlete on the stopped-coming list, and when (OW27-33 B; Overwatch W4-6 Q4 A). One current mark per athlete; a mark ends by a take-back or, once the athlete has come back and stopped again, by being replaced (cleared_at, cleared_kind), keeps its row, and a later mark is a new row. No note or free text for any age. An account''s delete clears its id here. Staff only. Lane W4-6, SC-3a-1.';
