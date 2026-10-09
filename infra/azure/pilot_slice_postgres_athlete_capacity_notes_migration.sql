-- Athlete capacity notes (pilot.athlete_capacity_notes): module 013's one
-- vertical slice, "physical capacity note field on athlete or session (coach
-- write, read own/assigned)" (OD-2026-10-08-002, C1 item 1: modules 7, 13 and
-- 70 are the never-built modules to build). Overwatch's design call
-- (2026-10-08): notes are PER ATHLETE, dated, kept as history (newest first),
-- written by a coach who reaches the athlete or the organization admin, and
-- read by the staff who reach the athlete.
--
-- PLAIN TEXT, IN THE COACH'S WORDS. One row is one note: what a coach saw of
-- an athlete's physical capacity today, typed by that coach. There is no
-- score, no number column and no metric: the module boundaries (docs/
-- capabilities/modules/013-physical-capacity-engine.md) forbid invented
-- sensor metrics, automatic safety-gate changes and board rows, and nothing
-- here parses a number out of the text. In-app AI never diagnoses
-- (OD-2026-09-21-001); this table is a coach's note, not an assessment.
--
-- HISTORY, NOT A FIELD. A note is never edited. A coach who wrote one may
-- withdraw it, which sets deleted_at and leaves the row (the audit trail
-- stays whole); reads skip withdrawn rows. The row never carries who deleted
-- it because only its author can: the audit row records the withdrawal.
--
-- WHO READS IT is the module's rule (athleteCapacityNotes.ts): staff with an
-- active membership here who reach the athlete through
-- assertActorCanAccessAthlete. Whether the athlete or their family sees
-- these notes is NOT decided; nothing shows them one.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-athlete-capacity-notes-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.athlete_capacity_notes (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  note_id            uuid not null,
  athlete_id         text not null,
  -- The coach's words. Never blank (spaces, tabs and line breaks alone do not
  -- count); at most 2000 characters, the module's cap as well.
  note               text not null
    constraint pilot_athlete_capacity_notes_note_check check (
      length(btrim(note, E' \t\r\n')) > 0 and length(note) <= 2000
    ),
  author_account_id  text not null,
  author_role        text not null
    constraint pilot_athlete_capacity_notes_role_check check (author_role in ('coach', 'organization_admin', 'admin')),
  created_at         timestamptz not null default clock_timestamp(),
  -- Set when the author withdraws the note; the row stays.
  deleted_at         timestamptz null,
  -- Insertion order. "Newest first" is decided by this, never by a timestamp:
  -- two notes in the same clock tick cannot tie.
  note_seq           bigint generated always as identity,
  primary key (organization_id, note_id),
  constraint pilot_athlete_capacity_notes_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

-- The read path: one athlete's live notes, newest first.
create index if not exists idx_athlete_capacity_notes_athlete_seq
  on pilot.athlete_capacity_notes(organization_id, athlete_id, note_seq desc)
  where deleted_at is null;

comment on table pilot.athlete_capacity_notes is
  'Coach-written plain-text physical capacity notes for one athlete, dated, kept as history (newest first); the author may withdraw one (deleted_at). No scores or metrics. Module 013 slice, OD-2026-10-08-002.';
