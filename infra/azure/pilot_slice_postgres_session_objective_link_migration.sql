-- Which objectives did this session address? (register module 036.)
--
-- WHAT THIS IS: one link table joining a DELIVERED SESSION
-- (pilot.session_script_runs, through the block link) to a FULL SPECTRUM
-- OBJECTIVE (pilot.athlete_development_block_objectives). It completes the
-- build order's PR F, whose three bullets were "which athlete development
-- block a session supports", "which objectives the session addresses" and
-- "which actual activities occurred". The first and third shipped with the
-- block link; this is the second, which waited because the objectives table
-- belonged to an unmerged PR and building against one would have made that
-- migration undeployable.
--
-- AN OBJECTIVE LINK IMPLIES A BLOCK LINK, AND THE DATABASE HOLDS IT.
-- An objective lives inside exactly one block. So "this Tuesday class
-- addressed the objective 'stop drifting to the ropes'" cannot be true unless
-- that same class supported the block that objective belongs to. Left to a
-- query habit, the two records drift: a coach marks an objective, the block
-- read does not show the session, and neither answer is wrong on its own.
--
-- Two composite foreign keys make it a fact instead:
--
--   (organization_id, run_id, block_id)
--       -> pilot.session_run_development_block_links
--       the block link must already exist. Not "should": the row cannot be
--       written without it.
--
--   (organization_id, objective_id, block_id)
--       -> pilot.athlete_development_block_objectives
--       and the objective must really belong to THAT block, so the block_id
--       carried here cannot drift from the objective's own parent.
--
-- Together they mean block_id is not a denormalisation anyone has to keep
-- true by hand -- it is the join key both constraints check, and a row that
-- lied about either relationship cannot exist.
--
-- THE ONE THING THIS ADDS TO ANOTHER LANE'S TABLE, and why it is safe. The
-- second foreign key needs a unique index on
-- pilot.athlete_development_block_objectives(organization_id, objective_id,
-- block_id). That table's primary key is already (organization_id,
-- objective_id), so this index is a strict superset of a key that exists and
-- is satisfied by every row that could ever be in the table. It adds an
-- index; it changes no semantics, no column, no constraint on what that
-- table will accept, and #762's own tests are unaffected. It is created here
-- rather than there because it exists only to serve this foreign key.
--
-- A LINK IS A COACH'S STATEMENT, NEVER AN INFERENCE. Nothing derives an
-- objective link from a session's date, from the drills it ran, from the
-- objective's domain, or from text matching between a script and an
-- objective. A human says a class worked on something and that saying is
-- what is stored. An inferred link would be this platform deciding what a
-- session was FOR -- which is coaching -- and a plan-versus-actual read built
-- on it would be comparing a plan against its own guesses.
--
-- NOTHING IS COUNTED, AND THE PRESSURE IS HIGHER HERE THAN ANYWHERE ELSE IN
-- THIS LANE. Objectives have a domain and a status; sessions now attach to
-- them. That is one GROUP BY away from "technical: 4 sessions, nutrition: 0",
-- a per-domain coverage chart about a child's training, and one step further
-- from an objective marked complete because enough sessions pointed at it.
-- There is no count, coverage, adherence, weight, effort, contribution or
-- percentage column here, and none may be added. How much a session moved an
-- objective is a coaching judgement this platform does not possess, and a
-- number would be believed precisely because it looked measured.
--
-- WHAT A ZERO WOULD MEAN, and why no surface may render one. A domain with no
-- linked sessions has not been shown to be neglected: it means nobody
-- recorded a link, which is the ordinary state of a record coaches fill in
-- when they have time. Presenting that as a gap in a child's programme would
-- be the honesty rule's exact failure -- a failed or absent read rendered as
-- a finding.
--
-- ON DELETE CASCADE ON BOTH SIDES, FOR THE REASON THE BLOCK LINK RECORDS.
-- dataDeletion.ts's purgeExpiredDeletedData issues a bare
-- `delete from pilot.athletes` inside one transaction and relies entirely on
-- cascades. The chain to here is now four deep -- athlete -> block ->
-- objective -> this row, and athlete -> block -> block link -> this row -- so
-- a NO ACTION key on either foreign key would roll that transaction back and
-- leave a soft-deleted minor's record past its retention date. Both parents
-- are deleted in the same statement and Postgres removes this row once; a
-- test runs the purge's exact statement rather than trusting the paragraph.
--
-- THE PRIMARY KEY IS THE PAIR. (organization_id, run_id, objective_id): the
-- same session cannot address the same objective twice, so a double-submit is
-- refused by the database. No surrogate id, because the pair is the identity
-- and a second id would let the duplicate exist.
--
-- WHAT IS DELIBERATELY ABSENT:
--   * No note or outcome column. What the session did is already on the run
--     (deviation_note, what_worked, what_did_not) and what the objective is
--     is already on the objective. A third free-text field here would split
--     one account across three tables.
--   * No "how much" of any kind -- see above.
--   * No status. This row records that a session addressed an objective. The
--     objective's own lifecycle is the objective's, moved by a human through
--     setBlockObjectiveStatus, and nothing here advances it.
--
-- Idempotent like every migration in this directory: create table/index if
-- not exists, no alters, no drops, safe to re-run wholesale. No begin;/
-- commit; here -- the runner
-- (apps/web/scripts/pilot-apply-session-objective-link-migration.mjs) opens
-- the transaction itself.
--
-- DEPENDS ON pilot.organizations, pilot.accounts,
-- pilot.athlete_development_block_objectives,
-- pilot.session_run_development_block_links.

-- The unique index the objective foreign key below references. A strict
-- superset of that table's own primary key (organization_id, objective_id),
-- so it constrains nothing that was not already true.
create unique index if not exists uq_adb_objectives_org_objective_block
  on pilot.athlete_development_block_objectives(organization_id, objective_id, block_id);

create table if not exists pilot.session_run_block_objective_links (
  organization_id      text not null references pilot.organizations(organization_id) on delete cascade,
  run_id               text not null,
  objective_id         text not null,
  -- Not a denormalisation kept true by hand: it is the join key BOTH foreign
  -- keys below check, so a row cannot claim an objective that belongs to a
  -- different block, or a session that never supported this one.
  block_id             text not null,
  -- Who said this session addressed this objective. Provenance, not
  -- authority: whether they may say it about this athlete is decided by the
  -- central athlete-access contract, which the data layer applies on every
  -- write.
  linked_by_account_id text not null references pilot.accounts(account_id),
  created_at           timestamptz not null default now(),
  primary key (organization_id, run_id, objective_id),
  constraint pilot_session_run_objective_links_objective_fk
    foreign key (organization_id, objective_id, block_id)
    references pilot.athlete_development_block_objectives(organization_id, objective_id, block_id)
    on delete cascade,
  constraint pilot_session_run_objective_links_block_link_fk
    foreign key (organization_id, run_id, block_id)
    references pilot.session_run_development_block_links(organization_id, run_id, block_id)
    on delete cascade
);

-- "Which sessions worked this objective" -- the read a coach does when they
-- open a block and look down its objectives.
create index if not exists idx_session_run_objective_links_by_objective
  on pilot.session_run_block_objective_links(organization_id, objective_id, created_at desc);

-- "Which objectives did this class address" -- the read from the session
-- side. The primary key's leading edge already serves (organization_id,
-- run_id), so this one exists for the block-scoped sweep instead.
create index if not exists idx_session_run_objective_links_by_block
  on pilot.session_run_block_objective_links(organization_id, block_id, run_id);

comment on table pilot.session_run_block_objective_links is
  'Which Full Spectrum objectives a coach says a delivered session addressed. Many-to-many: one session may address several objectives, and one objective is worked across many sessions. A coach''s statement, never inferred from dates, drills or domain. Nothing here counts, scores, weights or derives coverage -- an objective with no linked sessions means nobody recorded a link, never that the domain was neglected.';

comment on column pilot.session_run_block_objective_links.block_id is
  'The block both the objective and the session link belong to. Carried so the two composite foreign keys can hold the invariant that an objective link implies a block link, and that the objective really belongs to that block. Never set independently.';
