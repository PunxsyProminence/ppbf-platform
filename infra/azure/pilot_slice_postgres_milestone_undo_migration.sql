-- An athlete's own "I did it" on a milestone can be taken back (lane L43, F-133).
--
-- THE RULING. OD-2026-10-17-003 (UXB-19), Jason: "A: One tap + Undo
-- (Recommended)" -- "10-minute undo of their own mark; never touches a coach's
-- mark; history kept." #1704 built it for own-words goals (pilot.goals already
-- had reached_at to set back to null). pilot.athlete_milestones had nothing to
-- record a reversal with: its only state is the row itself, and the row is the
-- award. This is that column.
--
-- A REVERSAL, NOT A DELETE. `undone_at` is set when the athlete takes their own
-- mark back; the row stays. Reads that show or count awards leave out a row
-- whose undone_at is set. A later real mark of the same milestone (or a
-- coach's award) brings the same row back with its new date and undone_at
-- null -- the primary key stays one row per athlete per milestone, so there is
-- still no per-athlete count of anything. The mark and its undo are each an
-- audit event (pilot.audit_events), which is where the history is kept, the
-- same as #1704's goals.
--
-- NEVER A COACH'S MARK, AT THE DATABASE. The check below admits undone_at only
-- on a row the athlete marked themselves (awarded_by_role = 'self'). The
-- application's undo statement says the same thing; this is what still holds
-- if a later statement forgets to. A coach's award is stored as the coach's --
-- including on a milestone the athlete had already marked themselves, which
-- the application's award statement then makes the coach's (first date kept)
-- -- so once a coach has marked it, no undo of it can be stored. A coach
-- awarding an undone row writes awarded_by_role = 'coach' and undone_at = null
-- in the same statement, which satisfies the check. Every existing row has
-- undone_at null, so the check validates at once.
--
-- WHO MAY UNDO, AND FOR HOW LONG (the athlete, their own account's mark,
-- ten minutes by the database's clock) is the application's statement to
-- enforce; nothing here infers it.
--
-- DEPENDS ON pilot.athlete_milestones (the achievements migration).
-- Idempotent: add column if not exists, and the check is added only when
-- absent. Nothing dropped, no data rewritten, no backfill. No begin;/commit;
-- here on purpose, matching this repo's runner-opens-the-transaction
-- convention (the runner is apps/web/scripts/pilot-apply-milestone-undo-migration.mjs).

alter table pilot.athlete_milestones
  add column if not exists undone_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_athlete_milestones_undo_self_only'
      and conrelid = 'pilot.athlete_milestones'::regclass
  ) then
    alter table pilot.athlete_milestones
      add constraint pilot_athlete_milestones_undo_self_only
      check (undone_at is null or awarded_by_role = 'self');
  end if;
end
$$;

comment on column pilot.athlete_milestones.undone_at is
  'When the athlete took back their own "I did it" (OD-2026-10-17-003: ten minutes, their own mark only). Null = the award stands. Set only on a self-marked row (pilot_athlete_milestones_undo_self_only). Undo never deletes the row, and a later real mark brings it back.';
