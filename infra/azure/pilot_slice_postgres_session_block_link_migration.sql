-- Which development block did this session support? (register module 036.)
--
-- WHAT THIS IS: one link table joining a DELIVERED SESSION
-- (pilot.session_script_runs) to an ATHLETE DEVELOPMENT BLOCK
-- (pilot.athlete_development_blocks). Nothing else. No new session table, no
-- new plan table, no columns added to either side.
--
-- WHY A LINK TABLE AND NOT A COLUMN. The build order is explicit: "Do not
-- require every group session to be exclusively owned by one block. Allow
-- many-to-many linkage if repository patterns support it cleanly." A
-- block_id column on pilot.session_script_runs would encode the opposite --
-- one owner per session -- and a Tuesday class that moved three different
-- athletes' blocks forward is the ordinary case in a gym, not the exception.
-- The repository does support the pattern cleanly: this is the same shape
-- pilot.mentorships and pilot.external_competition_entries already use.
--
-- NOTHING IS REPLACED. The order lists six things not to replace -- session
-- scripts, workout templates, drills, cue library, floor groups, training
-- attempts -- and this migration touches none of them. It adds references
-- between two tables that already exist and alters neither.
--
-- A LINK IS A COACH'S STATEMENT, NOT A DERIVED FACT. Nothing infers that a
-- session supported a block because the dates overlap, because the athlete
-- was present, or because a drill matched an emphasis string. A coach says
-- so, and their saying so is what is stored -- linked_by_account_id records
-- who said it. An inferred linkage would be this platform asserting what a
-- session was FOR, which is coaching, and it would then feed a plan-vs-actual
-- read built out of its own guesses.
--
-- NOTHING IS COMPUTED HERE EITHER. No count of sessions per block, no
-- "coverage" or "adherence" percentage, no progress figure, and no column
-- that could hold one. The refusal is inherited from
-- pilot.athlete_development_blocks and restated because this table is exactly
-- where the temptation arrives: once sessions are countable against a plan, a
-- "72% of planned sessions delivered" figure is one SQL aggregate away, and
-- it would be a compliance score about a coach's work with a child assembled
-- from a link nobody validated. How well a block is going is a coaching
-- judgement this platform does not make.
--
-- TENANCY IS A DATABASE FACT, NOT A QUERY HABIT. Both foreign keys are
-- composite -- (organization_id, run_id) and (organization_id, block_id) --
-- so a link cannot join a session in one gym to a block in another. Not
-- "should not": cannot. Same shape the foundation used for pilot.athletes.
--
-- THE PRIMARY KEY IS THE PAIR. (organization_id, run_id, block_id) means the
-- same session cannot be linked to the same block twice, so a double-submit
-- is refused by the database rather than by a caller remembering to check --
-- and there is no surrogate link_id, because the pair IS the identity and a
-- second id would let the duplicate exist.
--
-- ON DELETE CASCADE ON BOTH SIDES, AND THE BLOCK SIDE IS NOT A PREFERENCE.
-- pilot.athlete_development_blocks cascades from pilot.athletes, and
-- dataDeletion.ts's purgeExpiredDeletedData issues a bare
-- `delete from pilot.athletes where deleted_at < now() - interval '2 years'`
-- inside one transaction, relying entirely on cascades to carry the children.
-- A NO ACTION or RESTRICT foreign key here would make that delete fail, roll
-- the transaction back, and leave a soft-deleted minor's record in the
-- database past the retention period it was scheduled for -- the one
-- irreversible delete path in the platform, broken by a link table. Cascade
-- is what keeps the purge whole, and a test asserts the purge still works
-- with a link present rather than trusting this paragraph.
--
-- The run side is cascade for the ordinary reason: a link to a session that
-- no longer exists is not a record of anything.
--
-- WHAT IS DELIBERATELY ABSENT:
--   * No objective link. "Which objectives the session addresses" is the
--     build order's second bullet and it needs
--     pilot.athlete_development_block_objectives, which is PR #762's table
--     and is NOT on main. Building against an unmerged table from another
--     lane would make this migration undeployable. Nothing here forecloses
--     it: an objective link is a second link table, or a nullable column on
--     this one, whenever #762 lands.
--   * No note or rationale column. What the session did is already recorded
--     on the run itself -- deviation_note, what_worked, what_did_not -- and a
--     second free-text field here would split one account of a session across
--     two tables.
--   * No ordering or weighting. A session does not support one block "more"
--     than another, and a number saying it did would be invented.
--
-- Idempotent like every migration in this directory: create table/index if
-- not exists, no alters, no drops, safe to re-run wholesale. No begin;/
-- commit; here -- the runner
-- (apps/web/scripts/pilot-apply-session-block-link-migration.mjs) opens the
-- transaction itself.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.session_script_runs,
-- pilot.athlete_development_blocks.

create table if not exists pilot.session_run_development_block_links (
  organization_id      text not null references pilot.organizations(organization_id) on delete cascade,
  run_id               text not null,
  block_id             text not null,
  -- Who said this session supported this block. Provenance, not authority:
  -- whether that account may say it is decided by the athlete-access contract
  -- the data layer applies on every write, exactly as
  -- pilot.athlete_development_blocks.created_by_account_id is documented.
  linked_by_account_id text not null references pilot.accounts(account_id),
  created_at           timestamptz not null default now(),
  -- The pair is the identity. No surrogate id: one would permit the duplicate
  -- this key exists to refuse.
  primary key (organization_id, run_id, block_id),
  constraint pilot_session_run_block_links_run_fk
    foreign key (organization_id, run_id)
    references pilot.session_script_runs(organization_id, run_id) on delete cascade,
  constraint pilot_session_run_block_links_block_fk
    foreign key (organization_id, block_id)
    references pilot.athlete_development_blocks(organization_id, block_id) on delete cascade
);

-- "Which sessions worked this block" -- the read a coach does when they open
-- a block. The primary key already serves the other direction, since
-- (organization_id, run_id) is its leading edge.
create index if not exists idx_session_run_block_links_by_block
  on pilot.session_run_development_block_links(organization_id, block_id, created_at desc);

comment on table pilot.session_run_development_block_links is
  'Which delivered sessions a coach says supported which athlete development blocks. Many-to-many on purpose: one group session may serve several athletes'' blocks, and one block is worked across many sessions. A coach''s statement, never inferred from overlapping dates or attendance. Nothing here counts, scores or derives adherence.';

comment on column pilot.session_run_development_block_links.linked_by_account_id is
  'Which account said this session supported this block. Provenance, not authority: whether they may say it about this athlete is decided by the central athlete-access contract, which the data layer applies on every write.';
