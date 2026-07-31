-- Film Study proposed observations (pilot.shadow_film_study_proposals).
--
-- Storage for the ONLY thing the Film Study vision pipeline is allowed to
-- produce: a PROPOSAL. Issue #103's safety design, approved by the owner
-- 2026-07-31, states that vision output is an AI observation about an
-- identifiable minor and therefore never touches an athlete record on its
-- own -- a human coach must accept it first.
--
-- Why this needs its own table rather than an existing one, having checked
-- all three candidates:
--
--   * pilot.shadow_decisions records that a HUMAN decided something. Its
--     decided_by_account_id/decided_by_role are the deciding human, and its
--     audit action is literally 'recorded'. Writing machine proposals there
--     would misattribute authorship in the one place authorship is the point.
--   * pilot.coach_observations requires coach_account_id referencing a real
--     account. A proposal has no coach yet -- that is what acceptance
--     supplies -- so it cannot satisfy that column honestly.
--   * pilot.shadow_human_review_queue carries filtered CHAT responses keyed
--     to a conversation. A film-study proposal has no conversation and needs
--     structured per-athlete, per-video fields.
--
-- THE EXIT IS PART OF THE SCHEMA, deliberately. On 2026-07-31 the feedback
-- review queue was found to have no exit at all: eligibility conditions had
-- been written as existence conditions, so filtered items could be neither
-- approved nor rejected and sat forever, capping every counter behind them
-- (audit C1/C2, fixed in #122). The lesson is encoded here: review_state has
-- exactly three values and BOTH terminal states are always reachable from
-- pending_review. Nothing about a proposal's content can make it
-- unreviewable -- an unusable proposal is precisely what rejection is for.
--
-- Frames are NOT stored. #103's retention rule is that extracted frames live
-- only in a per-job temp directory and are deleted after inference; the
-- durable artifacts are this row and the source video already in
-- pilot.video_sessions. There is deliberately no frame_blob_path column, so
-- the schema cannot be used to quietly start persisting images of minors.
--
-- Additive and idempotent. Apply through the controlled migration runner,
-- never from an HTTP request.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-film-study-proposals-migration.mjs) opens the
-- transaction itself, matching the announcements / video-sessions
-- convention. The shadow-runtime runner takes the opposite convention, and
-- mixing them took every migration in that set down once already (#107).

create table if not exists pilot.shadow_film_study_proposals (
  proposal_id uuid primary key,
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id text not null,
  video_session_id text not null,

  -- The job that produced this proposal, kept for provenance. Nullable
  -- because the row must survive job-history pruning: a coach reviewing a
  -- proposal cares about the observation, not about whether the queue row
  -- still exists.
  job_id uuid null,

  -- What the vision model actually said, already through the response
  -- validator. Doctrine (#103): observations only -- no diagnosis, no
  -- prescription, no clearance.
  observation_text text not null,

  -- Server-derived citable id for this proposal's evidence, mirroring the
  -- near-miss pattern (#100): claims about what the video shows are citable
  -- to the video, and to nothing else.
  evidence_id text not null,

  -- Provenance for the measured-facts discipline: which deployment produced
  -- it and how much of the clip it actually saw. A proposal built from 3
  -- frames is not the same claim as one built from 90.
  model_deployment text not null,
  frames_analyzed integer not null check (frames_analyzed > 0),

  review_state text not null default 'pending_review'
    check (review_state in ('pending_review', 'accepted', 'rejected')),

  -- The human attestation. All four are null until a coach acts, and the
  -- partial index below enforces that they arrive together.
  reviewed_by_account_id text null references pilot.accounts(account_id) on delete set null,
  reviewed_by_role text null,
  reviewed_at timestamptz null,
  review_notes text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_film_study_proposals_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,

  -- A settled proposal must name who settled it and when. Without this a
  -- row could reach 'accepted' with no attestation, which is exactly the
  -- auto-pass the safety design forbids.
  constraint pilot_film_study_proposals_attested
    check (
      (review_state = 'pending_review'
        and reviewed_by_account_id is null
        and reviewed_at is null)
      or (review_state in ('accepted', 'rejected')
        and reviewed_by_account_id is not null
        and reviewed_by_role is not null
        and reviewed_at is not null)
    )
);

-- The reviewer's queue: pending proposals for an organization, oldest first
-- (a proposal that has waited longest should be seen first).
create index if not exists idx_film_study_proposals_pending
  on pilot.shadow_film_study_proposals(organization_id, created_at asc)
  where review_state = 'pending_review';

-- Per-athlete history, all states, newest first.
create index if not exists idx_film_study_proposals_athlete
  on pilot.shadow_film_study_proposals(organization_id, athlete_id, created_at desc);

-- One proposal per job: the worker re-claims a job whose lease expired, and
-- without this a re-claimed job would append a second copy of the same
-- observation to the coach's queue. Partial, because job_id is nullable.
create unique index if not exists uq_film_study_proposals_job
  on pilot.shadow_film_study_proposals(job_id)
  where job_id is not null;
