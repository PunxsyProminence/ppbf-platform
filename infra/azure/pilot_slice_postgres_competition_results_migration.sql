-- Competition results on external-competition entries (owner decision
-- 2026-08-16, the failure-first doctrine applied to competition: "one
-- hard-fought loss is worth a thousand easy victories").
--
-- Each entry can carry ONE recorded result -- won / lost / draw /
-- no_contest -- and the structural rule of this migration is that a LOSS
-- REQUIRES A LESSON: a 'lost' result cannot be written without a non-blank
-- lesson_note. The database refuses an unexamined loss. Wins may carry a
-- note too, but only the loss demands one.
--
-- Additive and idempotent: add column if not exists; named constraints
-- added only when absent (drill-vocabulary-widening pattern). Existing
-- rows are untouched -- result stays null (no result recorded yet), which
-- is an honest state, never defaulted to anything.

alter table pilot.external_competition_entries
  add column if not exists result text null;
alter table pilot.external_competition_entries
  add column if not exists lesson_note text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.external_competition_entries')
      and conname = 'pilot_competition_entry_result_check'
  ) then
    alter table pilot.external_competition_entries
      add constraint pilot_competition_entry_result_check
      check (result is null or result in ('won', 'lost', 'draw', 'no_contest'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.external_competition_entries')
      and conname = 'pilot_competition_entry_loss_lesson_check'
  ) then
    alter table pilot.external_competition_entries
      add constraint pilot_competition_entry_loss_lesson_check
      check (result is distinct from 'lost' or length(btrim(lesson_note)) > 0);
  end if;
end $$;

comment on constraint pilot_competition_entry_loss_lesson_check on pilot.external_competition_entries is
  'Owner doctrine 2026-08-16: a loss requires a lesson. A lost result cannot be recorded without a non-blank lesson_note -- the record refuses an unexamined loss.';
