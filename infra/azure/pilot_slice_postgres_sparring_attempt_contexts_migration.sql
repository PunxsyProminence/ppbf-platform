-- Sparring contexts for the training-attempts ledger (owner decision,
-- 2026-08-16): failure capture must cover the different kinds of sparring
-- distinctly -- technical sparring, sparring games, sparring drills, and
-- open (other) sparring -- because where an attempt fails matters as much
-- as that it failed. A defense that holds in sparring drills and breaks in
-- open sparring is a transfer fact the ledger must be able to state.
--
-- WIDENED, NEVER NARROWED: every previously legal context stays legal;
-- four sparring contexts are added. Existing rows are untouched.
--
-- Follows the drill-vocabulary-widening pattern: the original check
-- constraint was unnamed (auto-named by Postgres), so this migration finds
-- it by definition, drops it, and re-adds a NAMED constraint with the
-- wider vocabulary. Idempotent: re-running finds the named constraint
-- already carrying the full vocabulary and leaves it in place.

do $$
declare
  existing record;
begin
  for existing in
    select con.conname
    from pg_constraint con
    where con.conrelid = to_regclass('pilot.training_attempts')
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%context_type%'
      and pg_get_constraintdef(con.oid) not ilike '%technical_sparring%'
  loop
    execute format('alter table pilot.training_attempts drop constraint %I', existing.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.training_attempts')
      and conname = 'pilot_training_attempts_context_type_check'
  ) then
    alter table pilot.training_attempts
      add constraint pilot_training_attempts_context_type_check
      check (context_type in ('session', 'drill_assignment', 'assessment', 'film_study', 'open_floor',
                              'technical_sparring', 'sparring_games', 'sparring_drills', 'open_sparring'));
  end if;
end $$;

comment on constraint pilot_training_attempts_context_type_check on pilot.training_attempts is
  'Widened 2026-08-16 (owner decision): sparring contexts are first-class attempt contexts -- technical_sparring, sparring_games, sparring_drills, open_sparring -- so failures are recorded WHERE they happen.';
