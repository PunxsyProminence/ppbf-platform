-- Film Study: coach-reported observations and the correction verdict.
--
-- Two gaps in pilot.shadow_film_study_proposals, both about what the review
-- queue CANNOT currently record.
--
-- GAP 1 -- THE QUEUE CANNOT SEE WHAT THE MODEL MISSED.
-- Every row in this table originates from the vision pipeline. A coach can
-- accept or reject what the model proposed, and nothing more. So the review
-- record describes only the model's own output, and a model that proposes one
-- easy observation per video and gets it accepted is indistinguishable, in
-- this table, from a model that finds everything. Any accept-rate computed
-- from these rows measures agreement on what was proposed; it is blind to
-- false negatives by construction, because there is no way to enter one.
--
-- This migration adds that way: `origin` distinguishes a proposal the model
-- made from an observation a coach entered because the model missed it.
--
-- GAP 2 -- A COACH WHO IS NEARLY RIGHT HAS TO REJECT.
-- review_state was pending_review / accepted / rejected. A coach who thinks
-- the observation is close but worded wrongly has only rejection available,
-- and what they knew is discarded with it. `corrected` keeps it:
-- corrected_observation_text holds the coach's replacement wording.
--
-- PROVENANCE IS RECORDED, NEVER FABRICATED.
-- model_deployment and frames_analyzed describe an inference run. A
-- coach-entered observation has no inference run, so those columns become
-- nullable and a check ties them to origin: a model row must state both, a
-- coach row must state neither and must instead name the coach. Filling a
-- coach row with model_deployment = 'none' and frames_analyzed = 1 would be
-- inventing provenance, which is the failure pilot.readiness was just
-- repaired for -- there, an unauditable number quietly acquired the authority
-- of a measured one. The alternative here is the same one taken there: record
-- what is true, and let the shape of the row say which kind of claim it is.
--
-- COACH-REPORTED ROWS STILL LAND pending_review, DELIBERATELY.
-- It is tempting to have a coach's own entry arrive pre-accepted -- they
-- wrote it, after all. It does not, for the reason this table's original
-- header records: on 2026-07-31 the feedback review queue was found to have
-- items that could reach no terminal state at all and sat forever (audit
-- C1/C2, #122). A row created already-settled has no exit either: nothing
-- could retract a mis-entered observation about a minor. One lifecycle, both
-- exits always reachable, for every origin.
--
-- CONSEQUENCE FOR ANY ACCEPT-RATE METRIC, STATED HERE SO IT IS NOT MISSED:
-- accepted/rejected counts must now be scoped to origin = 'model_proposed'.
-- A coach-reported observation that a coach accepts is not evidence that the
-- model was right -- it is evidence the model missed something. Counting it
-- as an acceptance would invert its meaning and inflate the very number it
-- was added to make honest.
--
-- Frames are still NOT stored. #103's retention rule is unchanged and there
-- is still deliberately no frame_blob_path column, so this migration cannot
-- be used to start persisting images of minors.
--
-- Additive and idempotent. The two widened CHECK constraints are dropped and
-- recreated by name inside DO blocks -- widening a vocabulary in its own
-- migration is the sanctioned pattern here (see the readiness-provenance
-- method check), because it forces the decision to be recorded rather than
-- edited into an existing file.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-film-study-coach-reported-migration.mjs)
-- opens the transaction itself, matching the film-study-proposals convention
-- this migration extends.
--
-- DEPENDS ON pilot.shadow_film_study_proposals (film-study-proposals),
-- pilot.accounts.

-- Where the row came from. Added with a default so existing rows backfill to
-- the truth -- before this migration the table could hold nothing but vision
-- output -- and the default is then dropped, so from here an insert that
-- omits origin fails rather than silently claiming to be a model proposal.
alter table pilot.shadow_film_study_proposals
  add column if not exists origin text not null default 'model_proposed';

alter table pilot.shadow_film_study_proposals
  alter column origin drop default;

-- The coach who entered a missed observation. Null for model proposals, which
-- have a model_deployment instead. on delete set null rather than cascade: a
-- departed coach's account going away must not delete an observation about an
-- athlete.
alter table pilot.shadow_film_study_proposals
  add column if not exists reported_by_account_id text null
    references pilot.accounts(account_id) on delete set null;

-- The coach's replacement wording when the verdict is 'corrected'. The
-- original observation_text is never overwritten -- both readings survive, so
-- a later reader can see what the model said and what the coach made of it.
alter table pilot.shadow_film_study_proposals
  add column if not exists corrected_observation_text text null;

-- An inference run's provenance does not apply to a coach's own entry, so
-- these stop being universally required and become conditional on origin
-- (enforced below). Dropping NOT NULL is a widening change and re-running it
-- against an already-nullable column is a no-op.
alter table pilot.shadow_film_study_proposals
  alter column model_deployment drop not null;

alter table pilot.shadow_film_study_proposals
  alter column frames_analyzed drop not null;

do $$
begin
  -- origin vocabulary.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_origin_check'
  ) then
    alter table pilot.shadow_film_study_proposals
      add constraint pilot_film_study_proposals_origin_check
      check (origin in ('model_proposed', 'coach_reported'));
  end if;

  -- Provenance matches origin, in both directions. A model row states its
  -- deployment and frame count and names no coach; a coach row names the
  -- coach and states neither. Neither kind can borrow the other's evidence.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_provenance'
  ) then
    alter table pilot.shadow_film_study_proposals
      add constraint pilot_film_study_proposals_provenance
      check (
        (origin = 'model_proposed'
          and model_deployment is not null
          and frames_analyzed is not null
          and reported_by_account_id is null)
        or (origin = 'coach_reported'
          and model_deployment is null
          and frames_analyzed is null
          and reported_by_account_id is not null)
      );
  end if;

  -- review_state widened to admit 'corrected'. The original constraint was
  -- declared inline, so Postgres named it for the column.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'shadow_film_study_proposals_review_state_check'
  ) then
    alter table pilot.shadow_film_study_proposals
      drop constraint shadow_film_study_proposals_review_state_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_review_state_check'
  ) then
    alter table pilot.shadow_film_study_proposals
      add constraint pilot_film_study_proposals_review_state_check
      check (review_state in ('pending_review', 'accepted', 'rejected', 'corrected'));
  end if;

  -- Attestation widened the same way: 'corrected' is a verdict, so it carries
  -- the same human attestation accepted and rejected do. A settled row of any
  -- kind still cannot exist without naming who settled it and when.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_attested'
  ) then
    alter table pilot.shadow_film_study_proposals
      drop constraint pilot_film_study_proposals_attested;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname = 'pilot_film_study_proposals_attested_v2'
  ) then
    alter table pilot.shadow_film_study_proposals
      add constraint pilot_film_study_proposals_attested_v2
      check (
        (review_state = 'pending_review'
          and reviewed_by_account_id is null
          and reviewed_at is null)
        or (review_state in ('accepted', 'rejected', 'corrected')
          and reviewed_by_account_id is not null
          and reviewed_by_role is not null
          and reviewed_at is not null)
      );
  end if;

  -- A correction must carry the corrected wording, and nothing else may.
  -- Without the second half, a rejected row could quietly hold replacement
  -- text nobody would ever read.
  -- Guarded on the WIDENED name as well as its own, because
  -- pilot_slice_postgres_film_study_revisions_migration.sql (later in the
  -- `all` chain) DROPS this constraint and replaces it with
  -- ..._correction_check_v2, which additionally permits a settled
  -- accepted/rejected proposal to keep the corrected wording. Without this
  -- guard a re-dispatch of `all` -- which the workflow performs wholesale on
  -- the stated premise that every migration re-applies as a no-op -- would
  -- find the v2-only name absent, re-add this NARROWER check, and fail
  -- validating it against exactly the rows v2 exists to allow. Those rows are
  -- not hypothetical: resolveFilmStudyProposal carries corrected_observation_text
  -- forward on an accept, so any proposal a coach corrected and then accepted
  -- is one. Re-adding a superseded constraint is wrong regardless; the widened
  -- one is already in force and already covers this column.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_film_study_proposals'::regclass
      and conname in (
        'pilot_film_study_proposals_correction_check',
        'pilot_film_study_proposals_correction_check_v2'
      )
  ) then
    alter table pilot.shadow_film_study_proposals
      add constraint pilot_film_study_proposals_correction_check
      check (
        (review_state = 'corrected'
          and length(btrim(coalesce(corrected_observation_text, ''))) > 0)
        or (review_state <> 'corrected'
          and corrected_observation_text is null)
      );
  end if;
end $$;

-- The accept-rate scope. Any measurement of how often coaches accept what the
-- MODEL proposed reads settled model rows only, and this index is the shape
-- that query takes -- so the correct scoping is the cheap path, not a rule
-- somebody has to remember.
create index if not exists idx_film_study_proposals_model_settled
  on pilot.shadow_film_study_proposals(organization_id, model_deployment, review_state)
  where origin = 'model_proposed' and review_state <> 'pending_review';

-- Coach-reported observations for an athlete, newest first: the "what did we
-- catch that the model did not" view.
create index if not exists idx_film_study_proposals_coach_reported
  on pilot.shadow_film_study_proposals(organization_id, athlete_id, created_at desc)
  where origin = 'coach_reported';
