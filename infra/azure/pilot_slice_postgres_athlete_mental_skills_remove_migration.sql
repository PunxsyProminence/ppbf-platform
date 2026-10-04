-- Athlete mental skills: the athlete removes their own entry (soft remove).
--
-- WHY. Owner decision OD-2026-10-04-023 ("Athlete can remove own
-- (Recommended)"): an athlete may take back a cue or an imagery log they
-- entered. The entry is HIDDEN, not erased: the row stays, with who removed it
-- and when, and the removal has its own audit record. There is no edit; a
-- removed entry is replaced by entering a new one.
--
-- WHAT CHANGES. Two nullable columns on pilot.athlete_mental_skill_entries:
--   removed_at -- when the athlete removed it; null while it is shown.
--   removed_by -- the account that removed it (always the athlete's own).
-- A pair check keeps them set together, so a row is never half-removed.
-- Existing rows get nulls, i.e. stay shown.
--
-- Requires pilot.athlete_mental_skill_entries
-- (pilot_slice_postgres_athlete_mental_skills_migration.sql); the `all` chain
-- runs `athlete-mental-skills` first.
--
-- Idempotent: add column if not exists; the pair check is dropped and re-added
-- on every run. No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-athlete-mental-skills-remove-migration.mjs)
-- opens the transaction itself.

alter table pilot.athlete_mental_skill_entries
  add column if not exists removed_at timestamptz null,
  add column if not exists removed_by text null;

alter table pilot.athlete_mental_skill_entries
  drop constraint if exists pilot_athlete_mental_skill_entries_removed_pair_check;
alter table pilot.athlete_mental_skill_entries
  add constraint pilot_athlete_mental_skill_entries_removed_pair_check
  check ((removed_at is null) = (removed_by is null));
