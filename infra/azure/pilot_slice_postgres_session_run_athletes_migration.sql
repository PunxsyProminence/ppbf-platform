-- Who was in a session, and a coach's note on them there (audit finding F-067).
--
-- WHY. A coach running a session -- a plain one or a scripted one -- could not
-- record who was present or write today's note on an athlete. The run row
-- (pilot.session_script_runs) names no athlete: it carries athletes_present, a
-- COUNT the coach types at End Session. And a staff note
-- (pilot.session_staff_notes) could only hang off the athlete's OWN session
-- row (pilot.sessions), which does not exist until the athlete logs the day.
--
-- This file is the schema for the fix and nothing else. It is ADDITIVE: it
-- creates one table and widens one, and changes no existing row. No code on
-- main reads or writes the new table or the new column when this lands; the
-- module and the screens follow in their own pull requests, after this is
-- applied.
--
-- 1. pilot.session_run_athletes -- one row per (run, athlete): this athlete
--    was marked present in this run, by whom, in what role, and when.
--
--    A MARK TAKEN BACK KEEPS ITS ROW. removed_at / removed_by_account_id are
--    set and the row stays (nothing is deleted); the two are set and cleared
--    together (pilot_session_run_athletes_removed_pair). The row holds the
--    mark's CURRENT state only: marking the athlete again clears both, so the
--    history of a mark made, taken back and made again is the audit trail's to
--    keep (the module writes it), not this table's.
--
--    SESSION DETAIL, NOT ATTENDANCE. This is who a coach saw in one session. It
--    is not the athlete-day record: pilot.activity_log is (CT-13,
--    docs/current/ATTENDANCE_PRECEDENCE.md), and pilot.attendance_reconciled
--    does not read this table. Whether a mark here should ever count toward a
--    participation figure is an owner decision that has not been made
--    (Overwatch, 2026-10-13: "a 'present' mark is session detail only and feeds
--    NO attendance report, reconciled view, board or grant figure").
--
--    WHO MAY WRITE AND READ is the module's business, not this file's, and
--    NOTHING HERE ENFORCES IT: the rule the module is to hold is the
--    delivering coach, while the run is live; staff of the gym read, each
--    athlete through the usual reach check; never an athlete, a parent, the
--    board or the platform owner (OD-2026-10-11-007, OD-2026-10-10-003 items 3
--    and 4). This file only refuses a mark made in a non-staff ROLE.
--
-- 2. pilot.session_staff_notes -- a note may now belong to a RUN instead of to
--    an athlete's own session:
--      * run_id, nullable;
--      * session_id becomes nullable;
--      * pilot_session_staff_notes_one_subject: exactly one of the two is set;
--      * pilot_session_staff_notes_run_athlete_fk: (organization, run, athlete)
--        must be a row of pilot.session_run_athletes. So a run note can only
--        name an athlete who has a mark row in THAT run. That is half of the
--        rule: whether the mark has since been taken back is the module's
--        check (the row is still there), and the module must lock the mark row
--        while it writes the note, because this foreign key's lock does not
--        stop a mark being taken back at the same moment.
--    Every existing row has a session_id and no run_id, satisfies the new
--    check, and is not touched. One notes table keeps one policy: the author
--    alone edits, a removed note keeps its row, staff only read.
--
--    NOTHING IS WRITTEN TO THE ATHLETE'S OWN TABLES by any of this:
--    pilot.sessions and pilot.athlete_check_ins are not altered or referenced.
--
-- DEPENDS ON pilot.session_script_runs (session-scripts, run-state and
-- session-run-plain migrations), pilot.session_staff_notes (session-staff-notes),
-- pilot.athletes, pilot.accounts, pilot.organizations.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-session-run-athletes-migration.mjs) opens the
-- transaction itself. Idempotent: every statement guards itself, because the
-- `all` chain re-runs every migration on every dispatch.

do $$
begin
  -- Fail loudly rather than installing half of it.
  if to_regclass('pilot.session_script_runs') is null then
    raise exception 'pilot.session_script_runs is missing: apply the session-scripts migration first';
  end if;
  if to_regclass('pilot.session_staff_notes') is null then
    raise exception 'pilot.session_staff_notes is missing: apply the session-staff-notes migration first';
  end if;
end $$;

create table if not exists pilot.session_run_athletes (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  run_id                 text not null,
  athlete_id             text not null,
  marked_by_account_id   text not null references pilot.accounts(account_id),
  marked_by_role         text not null
    constraint pilot_session_run_athletes_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin')),
  marked_at              timestamptz not null default clock_timestamp(),
  removed_at             timestamptz null,
  removed_by_account_id  text null references pilot.accounts(account_id),
  constraint pilot_session_run_athletes_pkey primary key (organization_id, run_id, athlete_id),
  constraint pilot_session_run_athletes_run_fk
    foreign key (organization_id, run_id)
    references pilot.session_script_runs(organization_id, run_id)
    on delete cascade,
  constraint pilot_session_run_athletes_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint pilot_session_run_athletes_removed_pair check (
    (removed_at is null) = (removed_by_account_id is null)
  )
);

-- "Which sessions was this athlete in": the read a finished-sessions screen
-- makes per athlete, newest first.
create index if not exists idx_session_run_athletes_athlete
  on pilot.session_run_athletes(organization_id, athlete_id, marked_at desc);

comment on table pilot.session_run_athletes is
  'An athlete a coach marked present in one session run (F-067). Session detail, NOT attendance: pilot.attendance_reconciled does not read it (CT-13). Holds the current state of each mark: one taken back keeps its row (removed_at, removed_by_account_id). Who may write and read it is the module''s rule, not a constraint here.';

-- ---------------------------------------------------------------------------
-- A staff note on a run.
alter table pilot.session_staff_notes
  add column if not exists run_id text null;

-- Idempotent: dropping NOT NULL from a nullable column is a no-op.
alter table pilot.session_staff_notes
  alter column session_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_session_staff_notes_run_athlete_fk'
       and conrelid = to_regclass('pilot.session_staff_notes')
  ) then
    alter table pilot.session_staff_notes
      add constraint pilot_session_staff_notes_run_athlete_fk
      foreign key (organization_id, run_id, athlete_id)
      references pilot.session_run_athletes(organization_id, run_id, athlete_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'pilot_session_staff_notes_one_subject'
       and conrelid = to_regclass('pilot.session_staff_notes')
  ) then
    alter table pilot.session_staff_notes
      add constraint pilot_session_staff_notes_one_subject
      check (num_nonnulls(session_id, run_id) = 1);
  end if;
end $$;

-- One index for two readers. The read "the notes on this run" (and "on this
-- athlete in this run"), and the foreign key above: when a mark row or a run
-- is deleted, Postgres looks the notes up by (organization_id, run_id,
-- athlete_id), removed ones included, so the index is not restricted to live
-- notes as idx_session_staff_notes_session is.
create index if not exists idx_session_staff_notes_run
  on pilot.session_staff_notes(organization_id, run_id, athlete_id, created_at)
  where run_id is not null;

-- The session-staff-notes migration describes this table as a note on "one
-- athlete's session" and re-stamps that on every dispatch. This file runs after
-- it, so the description that stands is this one.
comment on table pilot.session_staff_notes is
  'A coach''s or organization admin''s own note on one athlete, in the author''s name: on the athlete''s own session (session_id) or on the athlete in a session run (run_id, F-067), exactly one of the two. Author-only edit and removal (deleted_at); staff-only read. The athlete''s own note stays on pilot.sessions.notes. OD-2026-10-06-025 ruling 4; overwatch ruling B 2026-10-07.';

comment on column pilot.session_staff_notes.run_id is
  'Set when the note is on an athlete in a session RUN rather than on the athlete''s own session row (F-067). Exactly one of session_id and run_id is set; (organization_id, run_id, athlete_id) must be a row of pilot.session_run_athletes.';
