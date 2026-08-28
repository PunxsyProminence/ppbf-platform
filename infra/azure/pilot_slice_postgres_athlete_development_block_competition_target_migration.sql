-- Athlete development block -> competition/event target (register module 036).
--
-- WHAT THIS IS: the optional answer to "what is this block preparing for".
-- Two nullable columns on pilot.athlete_development_blocks, each a composite
-- foreign key into a competition surface that already exists, plus a check
-- that a block names at most one of them.
--
-- WHY IT EXISTS NOW, AND NOT IN THE FOUNDATION SLICE. The foundation
-- migration says, in its own words: "No target competition/event FK. Both
-- competition surfaces are deliberately skeletal by owner decision, and
-- whether a block may point at one is the proposal's Open Question 2 -- an
-- owner decision, not this migration's to make. Nothing here forecloses it:
-- an additive nullable column with a composite FK is a later one-column
-- migration if the owner chooses (a)."
--
-- The owner chose (a). This is that migration. Open Question 2 in
-- docs/capabilities/proposals/engine-unlock/036-periodization-block-planning-engine.md
-- put it as: "Yes -- allow an optional FK to
-- external_competitions.competition_id or wrestling_league_events.event_id
-- AS A TARGET DATE ONLY (name and date, nothing else), leaving both
-- competition tables exactly as skeletal as they are today." Every word of
-- that constrains what follows, and the proposal is updated in the same
-- change so the answer is recorded where the question was asked.
--
-- TWO COLUMNS, NOT ONE, AND AT MOST ONE SET. The option names two possible
-- targets in two different tables, so one polymorphic id column would have
-- to carry a discriminator and could not be a real foreign key -- the
-- tenancy proof below is worth more than the column count. The check keeps a
-- block from claiming to prepare for a boxing show and a wrestling meet at
-- the same time, which is not a plan anyone could deliver and would make
-- "the target date" ambiguous. NEITHER is required: a block with no target
-- is the ordinary case and stays valid.
--
-- A TARGET IS A DATE AND A NAME. NOTHING READS IT AS A TRAINING INPUT.
-- Neither competition table has brackets, weight classes, qualification
-- rules, or results-to-date, and both are skeletal by prior owner decision.
-- So nothing in this platform may derive a taper, a peak, a volume curve, an
-- intensity progression, a readiness threshold or a cut from the presence of
-- one of these columns, and no such column is added here. Pointing a block
-- at an event says when the coach is aiming; it does not say what to do
-- about it, and this platform does not possess that doctrine. The foundation
-- migration's refusal list applies to this widening unchanged.
--
-- TENANCY IS A DATABASE FACT, NOT A QUERY HABIT. Both FKs are composite --
-- (organization_id, competition_id) and (organization_id, event_id) -- so a
-- block cannot target an event in another gym. Not "should not", cannot. A
-- plain FK on the id alone would prove the row exists somewhere and prove
-- nothing about whose it is. Same shape the foundation used for
-- pilot.athletes, and the same shape pilot.wrestling_league_events itself
-- uses for its season.
--
-- ON DELETE IS DELIBERATELY THE DEFAULT (no action), NOT CASCADE AND NOT
-- SET NULL. Cascade would delete a coach's entire multi-week plan because
-- somebody removed a competition row -- the plan is the valuable record
-- here, not the target. Set null would silently erase what the block was
-- aiming at, leaving a block that looks like it never had a target. Neither
-- competition module ships a delete path today (a cancelled competition is
-- a STATUS, which is exactly how a called-off event is meant to be
-- recorded), so this restricts nothing that exists; if a delete path is
-- ever added, it will fail loudly here and whoever adds it will have to
-- decide what happens to the plans pointing at it, in the open. The
-- organization-level cascade already on both sides still removes everything
-- together when a whole gym is deleted.
--
-- CANCELLED EVENTS ARE KEPT, NOT UNLINKED. A block still points at a
-- competition whose status has become 'cancelled'. That is the honest
-- record -- the coach WAS preparing for it -- and the reading surfaces show
-- the cancellation rather than hiding the link. Silently dropping the
-- target would leave a coach unable to tell a cancelled event from one that
-- was never chosen.
--
-- Idempotent like every migration in this directory: add column if not
-- exists, constraints added only when absent, safe to re-run wholesale. No
-- begin;/commit; here -- the runner
-- (apps/web/scripts/pilot-apply-athlete-development-block-competition-target-migration.mjs)
-- opens the transaction itself.
--
-- DEPENDS ON pilot.athlete_development_blocks, pilot.external_competitions,
-- pilot.wrestling_league_events.

alter table pilot.athlete_development_blocks
  add column if not exists target_competition_id text null;

alter table pilot.athlete_development_blocks
  add column if not exists target_wrestling_event_id text null;

-- Idempotent constraint adds. `add constraint if not exists` does not exist
-- for table constraints in Postgres, so each is guarded by a catalogue
-- lookup on its own name -- the same thing `if not exists` would do, spelled
-- out because the shorthand is unavailable.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.athlete_development_blocks'::regclass
      and conname = 'pilot_athlete_development_blocks_target_competition_fk'
  ) then
    alter table pilot.athlete_development_blocks
      add constraint pilot_athlete_development_blocks_target_competition_fk
      foreign key (organization_id, target_competition_id)
      references pilot.external_competitions(organization_id, competition_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.athlete_development_blocks'::regclass
      and conname = 'pilot_athlete_development_blocks_target_wrestling_event_fk'
  ) then
    alter table pilot.athlete_development_blocks
      add constraint pilot_athlete_development_blocks_target_wrestling_event_fk
      foreign key (organization_id, target_wrestling_event_id)
      references pilot.wrestling_league_events(organization_id, event_id);
  end if;

  -- At most one target. Both null is the ordinary case and is allowed.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.athlete_development_blocks'::regclass
      and conname = 'pilot_athlete_development_blocks_single_target_check'
  ) then
    alter table pilot.athlete_development_blocks
      add constraint pilot_athlete_development_blocks_single_target_check
      check (
        (target_competition_id is not null)::int
        + (target_wrestling_event_id is not null)::int <= 1
      );
  end if;
end
$$;

-- "Which blocks are aimed at this event" -- the read a coach does when an
-- event moves or is called off. Partial, because the overwhelming majority
-- of blocks carry no target and have no business in this index.
create index if not exists idx_athlete_development_blocks_by_target_competition
  on pilot.athlete_development_blocks(organization_id, target_competition_id)
  where target_competition_id is not null;

create index if not exists idx_athlete_development_blocks_by_target_wrestling_event
  on pilot.athlete_development_blocks(organization_id, target_wrestling_event_id)
  where target_wrestling_event_id is not null;

comment on column pilot.athlete_development_blocks.target_competition_id is
  'Optional. The external competition this block is preparing for, in the same organization. A target date and a name only: nothing in this platform derives a taper, peak, volume curve or weight plan from it. Null is the ordinary case.';

comment on column pilot.athlete_development_blocks.target_wrestling_event_id is
  'Optional. The wrestling league event this block is preparing for, in the same organization. Same meaning and same refusals as target_competition_id; a block may name one target or neither, never both.';
