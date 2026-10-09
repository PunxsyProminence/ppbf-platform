-- Session staff notes (pilot.session_staff_notes): a note a COACH or
-- organization admin adds, in their own name, to one athlete's training
-- session (OD-2026-10-06-025 ruling 4, Jason: "Only the writer; coach adds own
-- note (Recommended)"; overwatch ruling B, 2026-10-07). The athlete's own
-- session note stays on pilot.sessions.notes and only the athlete may change
-- it (#1320); staff never rewrite it. They write HERE instead.
--
-- THE AUTHOR IS A COLUMN. pilot.sessions.notes records no author, which is why
-- that text can never be captioned with a name (privacyTiers.ts, sessions.notes).
-- Every row here carries author_account_id and author_role, so a reader can
-- name the coach who wrote it, and the author -- and only the author -- can
-- change or remove it.
--
-- MANY NOTES PER AUTHOR PER SESSION, each its own row: a coach may add a note
-- before a session and another after it. Nothing here collapses them.
--
-- EDITS ARE IN PLACE, BY THE AUTHOR ONLY (sessionStaffNotes.ts puts
-- author_account_id in the UPDATE's own WHERE; the table itself has no
-- trigger against UPDATE or DELETE). A removed note keeps its row with
-- deleted_at set, so the audit trail can still point at it.
--
-- WHO READS: staff only (coach reaching the athlete, organization admin). The
-- athlete and their guardians do NOT see staff notes; whether they should is
-- an owner decision nobody has made.
--
-- TWO FOREIGN KEYS, BOTH ORGANIZATION-SCOPED: (organization_id, session_id)
-- -> pilot.sessions and (organization_id, athlete_id) -> pilot.athletes, so a
-- note cannot outlive its session or name another gym's athlete. That the
-- session BELONGS TO that athlete is checked by the module inside the write
-- transaction (sessionStaffNotes.ts); pilot.sessions is not altered here
-- (overwatch 2026-10-08: no new constraint on the core table).
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-session-staff-notes-migration.mjs) opens the
-- transaction itself. Idempotent: every statement guards itself.

create table if not exists pilot.session_staff_notes (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  note_id            uuid not null,
  session_id         text not null,
  athlete_id         text not null,
  author_account_id  text not null references pilot.accounts(account_id),
  author_role        text not null
    constraint pilot_session_staff_notes_role_check check (author_role in ('coach', 'organization_admin', 'admin')),
  -- The coach's words. Never blank (spaces, tabs and line breaks alone do
  -- not count); at most 2000 characters.
  note               text not null
    constraint pilot_session_staff_notes_note_check check (
      length(btrim(note, E' \t\r\n')) > 0 and length(note) <= 2000
    ),
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  -- Set by the author to remove the note; the row stays for the audit trail.
  deleted_at         timestamptz null,
  primary key (organization_id, note_id),
  constraint pilot_session_staff_notes_session_fk
    foreign key (organization_id, session_id)
    references pilot.sessions(organization_id, session_id)
    on delete cascade,
  constraint pilot_session_staff_notes_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

-- The read path: every live note on one session, oldest first.
create index if not exists idx_session_staff_notes_session
  on pilot.session_staff_notes(organization_id, session_id, created_at)
  where deleted_at is null;

comment on table pilot.session_staff_notes is
  'A coach''s or organization admin''s own note on one athlete''s session, in the author''s name; author-only edit and removal (deleted_at); staff-only read. The athlete''s own note stays on pilot.sessions.notes. OD-2026-10-06-025 ruling 4; overwatch ruling B 2026-10-07.';
