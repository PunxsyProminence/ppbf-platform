-- Film Study correction revisions (pilot.film_study_proposal_revisions).
--
-- WHY. The 'corrected' verdict shipped one-shot: resolveFilmStudyProposal only
-- moved a row out of 'pending_review', so once a coach corrected an
-- observation it was settled and could never be corrected again. That is the
-- opposite of how the loop is actually used -- a coach reworks the wording
-- until the model's proposal is at least mostly right, and each pass is a
-- data point about how far wrong it started.
--
-- APPEND, NEVER OVERWRITE. The obvious fix -- let a coach edit the corrected
-- text in place -- would destroy the thing that makes a correction worth
-- keeping. Re-deciding a settled row overwrites who attested to it, and this
-- table's whole design is that a human attestation about an identifiable minor
-- survives. So each pass is a NEW ROW here, with its own author and timestamp,
-- and the proposal's original observation_text is never touched at all.
--
-- What that buys, beyond audit: one-shot correction tells you the model was
-- wrong. A revision chain tells you HOW wrong, and what the coach kept
-- changing -- which is the difference between a label and a training signal.
--
-- 'corrected' BECOMES NON-TERMINAL, DELIBERATELY. Before this it was an exit.
-- Now it means "in revision", and both real exits stay reachable from it: a
-- coach may correct again, ACCEPT once the wording is finally right, or reject
-- and give up on the proposal. Without the accept path out of 'corrected'
-- there would be no way to ever say "this is right now" -- the queue would
-- gain a state that could be entered and refined forever but never closed,
-- which is the C1/C2 shape (#122) in slow motion.
--
-- 'accepted' and 'rejected' stay terminal. Reopening them would overwrite an
-- attestation that was already given, and re-deciding a settled verdict is a
-- different feature from refining an unsettled one.
--
-- THE PROPOSAL'S corrected_observation_text IS A CACHE OF THE NEWEST REVISION.
-- It is written in the same statement that appends a revision, never
-- separately, so the two cannot drift; a test asserts they agree after several
-- passes. Keeping it means the review queue renders current wording without a
-- join, which matters because the queue is read far more often than the
-- history is.
--
-- Additive and idempotent. Creates one table; alters nothing.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-film-study-revisions-migration.mjs) opens the
-- transaction itself.
--
-- DEPENDS ON pilot.shadow_film_study_proposals (film-study-proposals,
-- film-study-coach-reported), pilot.accounts, pilot.organizations.

create table if not exists pilot.film_study_proposal_revisions (
  revision_id uuid primary key,

  proposal_id uuid not null
    references pilot.shadow_film_study_proposals(proposal_id) on delete cascade,

  -- Carried rather than joined so every read of a revision is organization
  -- scoped on its own, the same tenancy stance the rest of pilot.* takes.
  organization_id text not null
    references pilot.organizations(organization_id) on delete cascade,

  -- 1 for the first correction, incrementing per proposal. The unique index
  -- below is what makes this an ordering rather than a hint: two coaches
  -- correcting the same proposal at once cannot both claim the same number.
  revision_number integer not null check (revision_number > 0),

  -- The coach's wording at THIS pass. Never blank -- an empty rewrite would
  -- read downstream as agreement rather than as a correction.
  observation_text text not null
    check (length(btrim(observation_text)) > 0),

  -- Who made this pass. Not nullable: a revision with no author is exactly the
  -- unattributed edit this table exists to prevent.
  revised_by_account_id text not null references pilot.accounts(account_id),
  revised_by_role text not null,
  revised_at timestamptz not null default now(),

  -- Optional free note about WHY the wording changed. Distinct from the
  -- observation itself so a reader never mistakes a coach's rationale for a
  -- claim about the athlete.
  revision_note text null,

  constraint pilot_film_revisions_unique_number
    unique (proposal_id, revision_number)
);

-- Widen the correction check so a settled proposal KEEPS the wording it was
-- settled on.
--
-- The original constraint required corrected_observation_text to be null on
-- anything that was not 'corrected'. That was right when 'corrected' was a
-- terminal state, and is wrong now that it is a working one: the loop ends
-- with a coach ACCEPTING the wording they reworked, and under the old rule
-- that accept erased the very text they spent three passes getting right.
--
-- The invariants that still hold, and are what this re-states rather than
-- relaxes:
--   * 'corrected' must carry non-empty wording -- an empty rewrite would read
--     downstream as agreement.
--   * 'pending_review' must carry none -- nothing has corrected it yet, and a
--     pending row holding replacement text would be a correction nobody made.
--   * 'accepted' / 'rejected' may carry whatever the last pass left, including
--     nothing when the proposal was settled without ever being reworked.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_correction_check'
  ) then
    alter table pilot.shadow_film_study_proposals
      drop constraint pilot_film_study_proposals_correction_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_correction_check_v2'
  ) then
    alter table pilot.shadow_film_study_proposals
      add constraint pilot_film_study_proposals_correction_check_v2
      check (
        (review_state = 'corrected'
          and length(btrim(coalesce(corrected_observation_text, ''))) > 0)
        or (review_state = 'pending_review'
          and corrected_observation_text is null)
        or review_state in ('accepted', 'rejected')
      );
  end if;
end $$;

-- The history read: every pass on one proposal, in order.
create index if not exists idx_film_revisions_by_proposal
  on pilot.film_study_proposal_revisions(proposal_id, revision_number asc);

-- "How much reworking is this model costing us" -- revisions for an
-- organization over time, which is the measurement the chain makes possible.
create index if not exists idx_film_revisions_by_org
  on pilot.film_study_proposal_revisions(organization_id, revised_at desc);
