-- The training-attempts ledger (owner decision 2026-08-16: "every failure --
-- failed reps, failed time, failed distance"). One row per attempt: what was
-- attempted, what the target was, what actually happened.
--
-- FAILURE-FIRST BY DESIGN. A failed attempt is the most informative row in
-- this table, not an error state: the edge where an athlete fails IS their
-- current capacity, and a thousand easy makes define nothing. The owner's
-- phrasing is the design principle: one hard-fought loss is worth a
-- thousand easy victories. Every training-science engine still unbuilt in
-- the register (strength, energy systems, false-progress detection,
-- adaptation) reads this spine when its turn comes.
--
-- Direction matters and is stored, never guessed: reps/distance/load are
-- at_least targets (achieved >= target is made); times are at_most targets
-- (faster is made). 'made' is computed by the writing module from those two
-- facts and constrained here so a target-less attempt can never carry a
-- made/failed verdict it has no basis for.
--
-- Safeguarding shape, structural: rows carry the athlete LINK only; access
-- is staff plus the athlete's own records via the standing access checks.
-- NO leaderboard, ranking, or cross-athlete comparison surface may be built
-- on this table -- failure data describes training, never the child.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.training_attempts (
  organization_id        text not null,
  attempt_id             text not null,
  athlete_id             text not null,
  context_type           text not null default 'open_floor'
                         check (context_type in ('session', 'drill_assignment', 'assessment', 'film_study', 'open_floor')),
  context_id             text null,
  metric_kind            text not null
                         check (metric_kind in ('reps', 'time_seconds', 'distance_m', 'load_kg', 'rounds', 'hold_seconds')),
  direction              text not null default 'at_least' check (direction in ('at_least', 'at_most')),
  target_value           numeric null check (target_value is null or target_value > 0),
  achieved_value         numeric not null check (achieved_value >= 0),
  made                   boolean null,
  note                   text not null default '',
  attempted_at           timestamptz not null default now(),
  recorded_by_account_id text not null references pilot.accounts(account_id),
  created_at             timestamptz not null default now(),
  primary key (organization_id, attempt_id),
  constraint pilot_training_attempts_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  -- A verdict requires a target; a target requires a verdict. An open
  -- attempt (no target) is a measurement, not a make or a miss.
  constraint pilot_training_attempts_made_check
    check ((target_value is null) = (made is null))
);

-- The reading everything cares about: an athlete's attempts on one metric
-- over time -- where the failure edge sits and how it moves.
create index if not exists idx_training_attempts_athlete_metric
  on pilot.training_attempts(organization_id, athlete_id, metric_kind, attempted_at desc);
