-- Athlete development blocks (register module 036, foundation slice).
--
-- WHAT THIS IS: the durable record of a coach's own multi-week plan for one
-- athlete -- what the block is called, what the coach says it is FOR, the
-- window it runs over, and where it is in its own lifecycle. It is the
-- parent planning object that Full Spectrum objectives, sessions, actual
-- training data and a coach's review will later hang off. Nothing hangs off
-- it yet; this migration creates the parent and nothing else.
--
-- WHY IT EXISTS. The engine-unlock proposal for module 036
-- (docs/capabilities/proposals/engine-unlock/036-periodization-block-planning-engine.md)
-- established, against this directory read-only, that no table anywhere
-- stored a coach-authored training plan. The nearest things are not it:
-- pilot.session_scripts.phase is nullable free text on ONE delivered
-- session with no date range and no linkage between sessions sharing a
-- string; pilot.program_phases is program-level and deliberately carries no
-- athlete ids at all ("nothing here changes what any individual athlete is
-- doing"); pilot.intervention_protocols is scoped to one hypothesis about
-- one problem, sized in exposure dimension units. This table is the
-- proposal's Open Question 1 option (a): a new, purpose-built row that
-- REUSES the intervention ledger's vocabulary and refusals without
-- misusing its tables.
--
-- THIS TABLE RECORDS A PLAN. IT COMPUTES NOTHING. training_emphasis is the
-- coach's own words for what the block is for, stored verbatim and never
-- reinterpreted -- no fixed periodization taxonomy, no autocomplete, no
-- platform-asserted meaning. There is deliberately no readiness score, load
-- score, fatigue index, injury-risk value, compliance percentage, adherence
-- percentage, taper curve, or volume/intensity progression column here, and
-- none may be added: block structures and loading progressions are coaching
-- doctrine this platform does not possess. The same refusal
-- pilot.intervention_executions makes when it stores adherence as an
-- enumerated human-chosen STATE rather than a percentage, made here before
-- there is anything to be tempted by. This platform serves minors; a
-- machine-generated athletic ranking or an inferred physiological state has
-- no place in a record of what a coach decided to do.
--
-- LIFECYCLE IS THE REPOSITORY'S, NOT A NEW ONE. draft/active/completed/
-- cancelled is assembled from vocabulary already in this schema rather than
-- invented: pilot.return_to_training_plans -- the other coach-authored,
-- athlete-scoped, dated plan here -- uses exactly active/completed/
-- cancelled, and 'draft' is pilot.publications' first state. A block is
-- authored before it runs, so it starts at 'draft'. There is no 'archived'
-- and no 'superseded': a block that did not happen was cancelled, and a
-- block that ran to its end was completed. The database rejects anything
-- else.
--
-- TENANCY IS A DATABASE FACT, NOT A QUERY HABIT. The composite FK into
-- pilot.athletes(organization_id, athlete_id) means a block cannot name an
-- athlete in another organization -- not "should not", cannot -- the same
-- shape pilot.external_competition_entries and
-- pilot.intervention_protocols use. Athlete data is LINKED, never copied:
-- no name, dob, or weight class is duplicated here, so athlete records stay
-- governed where they already live.
--
-- WHAT IS DELIBERATELY ABSENT, so a later reader does not read absence as
-- oversight:
--   * No target competition/event FK. Both competition surfaces
--     (pilot.external_competitions, pilot.wrestling_league_events) are
--     deliberately skeletal by owner decision, and whether a block may
--     point at one is the proposal's Open Question 2 -- an owner decision,
--     not this migration's to make. Nothing here forecloses it: an
--     additive nullable column with a composite FK is a later one-column
--     migration if the owner chooses (a).
--   * No overlap constraint. Whether an athlete may be in two blocks at
--     once is coaching doctrine, and an exclusion constraint would decide
--     it silently.
--   * No child objective table. Full Spectrum objectives -- technical,
--     physical, conditioning, mental, nutrition, recovery, sparring,
--     competition prep, tactical, lifestyle -- are the NEXT slice, and they
--     are a child structure. A block table with a column per domain is
--     exactly the shape this refuses to be.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale. No
-- begin;/commit; here -- the runner
-- (apps/web/scripts/pilot-apply-athlete-development-blocks-migration.mjs)
-- opens the transaction itself, matching the programs and club-members
-- runners.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes.

create table if not exists pilot.athlete_development_blocks (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  block_id              text not null,
  athlete_id            text not null,
  -- BLANK MEANS BLANK, INCLUDING A TAB. The `length(btrim(x)) > 0` spelling
  -- used elsewhere in this directory trims SPACES ONLY -- btrim/1's default
  -- character set is ' ' -- so a title of E'\t\n' passes it while every
  -- JavaScript caller's .trim() calls the same value empty. The two layers
  -- would then disagree about what an empty field is, and the database would
  -- be the looser of the two. The explicit character set closes that: a
  -- value made only of whitespace is refused however it was typed. Caught by
  -- athleteDevelopmentBlocks.pg.test.ts asserting the tab case, which the
  -- one-argument form failed.
  title                 text not null
                        check (length(btrim(title, E' \t\r\n\f\v')) > 0),
  -- The coach's own words. A block whose stated intent is blank is a date
  -- range pretending to be a plan, so a blank is refused here the same way
  -- pilot.intervention_protocols refuses an empty hypothesis.
  training_emphasis     text not null
                        check (length(btrim(training_emphasis, E' \t\r\n\f\v')) > 0),
  starts_on             date not null,
  ends_on               date not null,
  status                text not null default 'draft',
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, block_id),
  -- Named rather than inline so the runner's readiness assertion and the
  -- migration test can both address them, and so a failure message says
  -- which rule was broken.
  constraint pilot_athlete_development_blocks_status_check
    check (status in ('draft', 'active', 'completed', 'cancelled')),
  -- A block cannot end before it begins. Both dates are required: a plan
  -- with no stated end is not a block, it is an intention.
  constraint pilot_athlete_development_blocks_interval_check
    check (ends_on >= starts_on),
  -- Composite FK: a block can only name an athlete in the SAME
  -- organization. A plain FK on athlete_id would prove existence and prove
  -- nothing about tenancy.
  constraint pilot_athlete_development_blocks_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

-- The athlete's own block history, newest window first: the read every
-- future surface starts from.
create index if not exists idx_athlete_development_blocks_by_athlete
  on pilot.athlete_development_blocks(organization_id, athlete_id, starts_on desc);

-- The gym's blocks by lifecycle state -- what is running now, what is
-- still a draft.
create index if not exists idx_athlete_development_blocks_by_org
  on pilot.athlete_development_blocks(organization_id, status, starts_on desc);

comment on table pilot.athlete_development_blocks is
  'A coach-authored multi-week development block for one athlete: title, the coach''s own stated training emphasis, a start and end date, and a lifecycle state. Records a plan; computes nothing. No readiness, load, fatigue, injury-risk, adherence or compliance value is stored or derived here.';

comment on column pilot.athlete_development_blocks.training_emphasis is
  'The coach''s own words for what this block is for. Stored verbatim, never coerced into a periodization taxonomy and never algorithmically reinterpreted.';

comment on column pilot.athlete_development_blocks.status is
  'draft (authored, not running) / active / completed / cancelled. Set by a human; the platform never advances it.';

comment on column pilot.athlete_development_blocks.created_by_account_id is
  'Which account authored the block. Provenance, not authority: whether that account may write blocks in this organization is decided by its active pilot.organization_memberships row, which the data layer checks on every create.';
