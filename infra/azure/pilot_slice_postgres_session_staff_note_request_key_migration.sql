-- Session staff notes: a request key, so one tap of "Add note" adds one note.
--
-- WHY (W4 item 7, the offline save queue; OD-2026-11-21-006, OW27-34 A and
-- OW27-35 A). A staff note a coach adds on the live floor that gets no clear
-- answer (the gym's wifi drops) is kept in the open page and sent again. The
-- server gives every added note a new random note_id
-- (sessionStaffNotes.ts createRunStaffNote / createSessionStaffNote), so a
-- second send of a note that had already landed would add it twice. A request
-- key closes that: the screen makes one random id for one tap and sends the
-- same id again on every resend, and a second send of that id returns the note
-- the first one added instead of writing another. This is the request key
-- pilot.intervention_executions already has
-- (pilot_slice_postgres_intervention_execution_request_key_migration.sql),
-- with the same limits.
--
-- WHAT CHANGES. One column on pilot.session_staff_notes:
--   request_key -- the id the caller's screen sent with the POST that added
--                  this note, or NULL when it sent none. Existing rows, and
--                  every note a caller without a key adds, stay NULL, and
--                  nothing is compared for them (the three staff-note panels
--                  off the floor send none, OW27-35 A).
-- One check: a key, when present, is not blank and at most 200 characters.
-- One partial unique index: a key names at most one note in an organization.
-- Editing or removing a note never changes its key.
--
-- Requires pilot.session_staff_notes
-- (pilot_slice_postgres_session_staff_notes_migration.sql); the `all` chain
-- runs it first.
--
-- Idempotent: add column if not exists; the check is added only when this table
-- has no check of that name, so a re-run (the `all` chain) does not re-scan the
-- table under an exclusive lock; create index if not exists. A same-named check
-- or index with any other definition is left for the runner's readiness check to
-- refuse. Additive only: nothing is dropped. No `begin;`/`commit;` here: the
-- runner (apps/web/scripts/pilot-apply-session-staff-note-request-key-migration.mjs)
-- opens the transaction.

alter table pilot.session_staff_notes
  add column if not exists request_key text null;

do $pilot_session_staff_notes_request_key_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_session_staff_notes_request_key_check'
      and conrelid = to_regclass('pilot.session_staff_notes')
  ) then
    alter table pilot.session_staff_notes
      add constraint pilot_session_staff_notes_request_key_check check (
        request_key is null or (length(btrim(request_key)) > 0 and length(request_key) <= 200)
      );
  end if;
end
$pilot_session_staff_notes_request_key_check$;

create unique index if not exists pilot_session_staff_notes_one_per_request_key
  on pilot.session_staff_notes(organization_id, request_key)
  where request_key is not null;

comment on column pilot.session_staff_notes.request_key is
  'Random id the caller''s screen sent for one tap of Add note, or NULL when it sent none. Unique per organization when set (pilot_session_staff_notes_one_per_request_key): a repeated send returns the note it added instead of writing a second one. Not changed by an edit or a removal.';
