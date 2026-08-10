-- ---------------------------------------------------------------------------
-- Widen two drill-library CHECK vocabularies to accept values the research
-- archive authors deliberately.
--
-- Owner decision, 2026-08-08. Both constraints were rejecting seed data that
-- the archive's own README documents as intentional, and both are the same
-- shape: a vocabulary written before the data that now has to live in it.
--
--   pilot.drill_scale_levels.authoring_state  + 'literature_grounded_draft'
--     228 of 357 supplied scale rows carry it. It marks an A or C scale row
--     generated from cited registry claims and NOT yet validated on the floor
--     -- a weaker state than 'authored', not a synonym for it. Collapsing it
--     into 'authored' would have claimed coach validation that never happened.
--
--   pilot.drill_stop_rules.rule_kind          + 'warmup_decay'
--     63 rules, attached to contact and maximal-effort drills only. In elite
--     boxers a standardized warm-up produced a 4.8% CMJ increase and a
--     25-minute inactive gap erased it (PMID 27191695). The existing kinds all
--     describe something going wrong DURING work; this one describes readiness
--     decaying while nothing happens, which none of them cover.
--
-- Both columns are widened, never narrowed: every value either constraint
-- accepted before is still accepted, so no existing row can be invalidated by
-- applying this.
--
-- The constraints are unnamed in the v3 migration, so Postgres auto-named them
-- (drill_scale_levels_authoring_state_check, drill_stop_rules_rule_kind_check).
-- This migration finds them through the catalog by the column they constrain
-- rather than trusting those generated names, and gives the replacements
-- explicit names so the next change can address them directly.
-- ---------------------------------------------------------------------------

-- pilot.drill_scale_levels.authoring_state ----------------------------------
do $$
declare
  existing record;
begin
  if to_regclass('pilot.drill_scale_levels') is null then
    raise exception 'DRILL_VOCAB_WIDENING_NOT_READY: pilot.drill_scale_levels does not exist -- apply the drill library v3 migration first';
  end if;

  -- Drop every CHECK on this table that mentions authoring_state, whatever it
  -- is called. Matching on the generated name alone would silently no-op if an
  -- earlier hand-applied fix had already renamed it, leaving the old narrow
  -- constraint in place and this migration reporting success.
  for existing in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'pilot'
      and rel.relname = 'drill_scale_levels'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%authoring_state%'
  loop
    execute format('alter table pilot.drill_scale_levels drop constraint %I', existing.conname);
  end loop;

  alter table pilot.drill_scale_levels
    add constraint pilot_drill_scale_authoring_state_check
    check (authoring_state in ('authored', 'scaffold_needs_coach_review', 'literature_grounded_draft'));
end $$;

comment on constraint pilot_drill_scale_authoring_state_check on pilot.drill_scale_levels is
  'literature_grounded_draft marks a scale row generated from cited registry claims and not yet validated on the floor. It is weaker than authored, not a synonym: do not collapse the two.';

-- pilot.drill_stop_rules.rule_kind ------------------------------------------
do $$
declare
  existing record;
begin
  if to_regclass('pilot.drill_stop_rules') is null then
    raise exception 'DRILL_VOCAB_WIDENING_NOT_READY: pilot.drill_stop_rules does not exist -- apply the drill library v3 migration first';
  end if;

  for existing in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'pilot'
      and rel.relname = 'drill_stop_rules'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%rule_kind%'
  loop
    execute format('alter table pilot.drill_stop_rules drop constraint %I', existing.conname);
  end loop;

  alter table pilot.drill_stop_rules
    add constraint pilot_drill_stop_rule_kind_check
    check (rule_kind in
      ('technique_degradation', 'fatigue', 'safety', 'intent_drift', 'coach_judgment', 'warmup_decay'));
end $$;

comment on constraint pilot_drill_stop_rule_kind_check on pilot.drill_stop_rules is
  'warmup_decay covers readiness lost across an inactive gap before contact or maximal effort (PMID 27191695), which the other kinds -- all of which describe something going wrong during work -- do not.';
