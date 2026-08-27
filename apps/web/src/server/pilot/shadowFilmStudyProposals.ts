// shadowFilmStudyProposals.ts — the human acceptance gate for Film Study.
//
// Issue #103's safety design (owner-approved 2026-07-31): vision output is an
// AI observation about an identifiable minor, so it is written as a PROPOSAL
// and never touches an athlete record until a human coach accepts it. This
// module is the whole lifecycle -- create, list, settle -- and it ships BEFORE
// the executor on purpose, so the exit exists before anything can pile up
// behind it.
//
// That ordering is not caution for its own sake. On 2026-07-31 the feedback
// review queue was found to have no exit at all: items could be neither
// approved nor rejected and sat forever, capping every counter behind them
// (audit C1/C2, fixed in #122). Shipping a producer before its reviewer is
// how a queue like that gets built.

import { randomUUID } from 'node:crypto';

import type { PilotRole } from './contracts';
import { query, queryOne } from './db';

export type FilmStudyProposalReviewState =
  | 'pending_review'
  | 'accepted'
  | 'rejected'
  | 'corrected';
export type FilmStudyProposalVerdict = Extract<
  FilmStudyProposalReviewState,
  'accepted' | 'rejected' | 'corrected'
>;

/**
 * Where the row came from. A model proposal states the deployment that made it
 * and how many frames it saw; a coach-reported observation states the coach.
 * Neither can borrow the other's provenance -- the database enforces that
 * (pilot_film_study_proposals_provenance), because a coach-entered observation
 * with a model_deployment filled in would be an invented inference run.
 */
export type FilmStudyProposalOrigin = 'model_proposed' | 'coach_reported';

export interface FilmStudyProposalRow {
  proposal_id: string;
  organization_id: string;
  athlete_id: string;
  video_session_id: string;
  job_id: string | null;
  origin: FilmStudyProposalOrigin;
  observation_text: string;
  evidence_id: string;
  // Null exactly when origin is 'coach_reported': there was no inference run
  // to describe.
  model_deployment: string | null;
  frames_analyzed: number | null;
  // Null exactly when origin is 'model_proposed'.
  reported_by_account_id: string | null;
  review_state: FilmStudyProposalReviewState;
  // The coach's replacement wording, present only on a 'corrected' row. The
  // original observation_text is never overwritten.
  corrected_observation_text: string | null;
  reviewed_by_account_id: string | null;
  reviewed_by_role: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
}

const PROPOSAL_COLUMNS = `
  proposal_id, organization_id, athlete_id, video_session_id, job_id,
  origin, observation_text, evidence_id, model_deployment, frames_analyzed,
  reported_by_account_id, review_state, corrected_observation_text,
  reviewed_by_account_id, reviewed_by_role, reviewed_at,
  review_notes, created_at, updated_at
`;

/**
 * The SQL predicate any "how often do coaches accept what the model proposed"
 * measurement must sit behind, exported so callers do not hand-roll it.
 *
 * A coach-reported observation that a coach then accepts is not evidence the
 * model was right -- it is evidence the model missed something. Counting it as
 * an acceptance would invert its meaning and inflate the very number the
 * missed-detection path was added to make honest.
 */
export const MODEL_PROPOSAL_SCOPE_SQL = "origin = 'model_proposed'";

/**
 * Build the citable evidence id for a proposal. Server-derived, mirroring the
 * near-miss pattern (#100): a claim about what a video shows is citable to
 * that video and to nothing else, and the id can never come from the model.
 */
export function buildFilmStudyEvidenceId(videoSessionId: string): string {
  return `film:${videoSessionId}`;
}

/**
 * Record one proposed observation. Always lands `pending_review` -- there is
 * deliberately no parameter that could create a pre-accepted proposal, since
 * that would be the auto-pass the safety design forbids.
 *
 * Idempotent per job: a worker whose lease expired mid-execution re-claims the
 * job, and without this the coach's queue would grow a second copy of the same
 * observation. The unique partial index on job_id is the enforcement; this
 * ON CONFLICT is the graceful half.
 */
export async function createFilmStudyProposal(input: {
  organizationId: string;
  athleteId: string;
  videoSessionId: string;
  jobId?: string | null;
  observationText: string;
  modelDeployment: string;
  framesAnalyzed: number;
}): Promise<FilmStudyProposalRow> {
  const row = await queryOne<FilmStudyProposalRow>(
    `insert into pilot.shadow_film_study_proposals
       (proposal_id, organization_id, athlete_id, video_session_id, job_id,
        origin, observation_text, evidence_id, model_deployment, frames_analyzed)
     values ($1, $2, $3, $4, $5, 'model_proposed', $6, $7, $8, $9)
     on conflict (job_id) where job_id is not null
       do update set updated_at = now()
     returning ${PROPOSAL_COLUMNS}`,
    [
      randomUUID(),
      input.organizationId,
      input.athleteId,
      input.videoSessionId,
      input.jobId ?? null,
      input.observationText,
      buildFilmStudyEvidenceId(input.videoSessionId),
      input.modelDeployment,
      input.framesAnalyzed,
    ],
  );
  if (!row) {
    throw new Error('SHADOW_FILM_PROPOSAL_WRITE_FAILED');
  }
  return row;
}

/**
 * Record an observation the coach saw and the model did not -- the missed
 * detection.
 *
 * Without this, the review record describes only what the vision pipeline
 * produced, so a model proposing one easy observation per video and getting it
 * accepted looks exactly like a model that finds everything. Acceptance rate
 * measures agreement on what was proposed and is blind to false negatives by
 * construction; this is the path that lets one be entered.
 *
 * It lands `pending_review` like any other row, and that is deliberate rather
 * than an oversight. Creating it pre-accepted would give it no exit, and a row
 * about an identifiable minor that nothing can retract is the C1/C2 failure
 * (#122) rebuilt in a new place. One lifecycle, both exits reachable, whoever
 * authored it.
 *
 * No model_deployment or frames_analyzed is written, and the database refuses
 * a coach row that carries them: there was no inference run, and describing
 * one would be inventing provenance.
 */
export async function createCoachReportedObservation(input: {
  organizationId: string;
  athleteId: string;
  videoSessionId: string;
  observationText: string;
  reportedByAccountId: string;
}): Promise<FilmStudyProposalRow> {
  const observationText = input.observationText.trim();
  if (!observationText) {
    throw new Error('Missing observation_text');
  }

  const row = await queryOne<FilmStudyProposalRow>(
    `insert into pilot.shadow_film_study_proposals
       (proposal_id, organization_id, athlete_id, video_session_id,
        origin, observation_text, evidence_id, reported_by_account_id)
     values ($1, $2, $3, $4, 'coach_reported', $5, $6, $7)
     returning ${PROPOSAL_COLUMNS}`,
    [
      randomUUID(),
      input.organizationId,
      input.athleteId,
      input.videoSessionId,
      observationText.slice(0, 4000),
      buildFilmStudyEvidenceId(input.videoSessionId),
      input.reportedByAccountId,
    ],
  );
  if (!row) {
    throw new Error('SHADOW_FILM_PROPOSAL_WRITE_FAILED');
  }
  return row;
}

/**
 * The coach's queue. `pending` is the working view; `all` is the audit view.
 * Pending is ordered oldest-first because the proposal that has waited longest
 * is the one most at risk of being forgotten.
 *
 * The working view holds 'corrected' as well as 'pending_review', because a
 * correction is a pass rather than an exit -- a proposal being reworked has
 * not left the queue, and dropping it after the first pass would make
 * "correct until it is right" impossible to actually do.
 */
export async function listFilmStudyProposals(input: {
  organizationId: string;
  state?: 'pending' | 'all';
  athleteId?: string | null;
  limit?: number;
}): Promise<FilmStudyProposalRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  return query<FilmStudyProposalRow>(
    `select ${PROPOSAL_COLUMNS}
     from pilot.shadow_film_study_proposals
     where organization_id = $1
       and ($2::text = 'all' or review_state in ('pending_review', 'corrected'))
       and ($3::text is null or athlete_id = $3)
     order by
       case when review_state in ('pending_review', 'corrected') then 0 else 1 end,
       case when review_state in ('pending_review', 'corrected') then created_at end asc,
       created_at desc
     limit ${limit}`,
    [input.organizationId, input.state ?? 'pending', input.athleteId ?? null],
  );
}

export async function getFilmStudyProposal(
  organizationId: string,
  proposalId: string,
): Promise<FilmStudyProposalRow | null> {
  return queryOne<FilmStudyProposalRow>(
    `select ${PROPOSAL_COLUMNS}
     from pilot.shadow_film_study_proposals
     where organization_id = $1 and proposal_id = $2`,
    [organizationId, proposalId],
  );
}

/**
 * Settle a proposal, or take another pass at correcting it.
 *
 * ALL THREE verdicts are always reachable, and nothing about the proposal's
 * content can block any of them -- an observation the coach disagrees with is
 * exactly what 'rejected' is for. That is the C1/C2 lesson (#122) encoded as a
 * rule rather than relearned.
 *
 * 'corrected' IS NOT TERMINAL. A coach reworks the wording until the model's
 * proposal is at least mostly right, so a correction can be made repeatedly --
 * from 'pending_review' the first time and from 'corrected' every time after.
 * Each pass appends a row to pilot.film_study_proposal_revisions with its own
 * author and timestamp; nothing is edited in place, and the model's original
 * observation_text is never touched at all.
 *
 * Both exits stay reachable from 'corrected': accept once the wording is
 * finally right, or reject and give up. Without the accept path there would be
 * no way to say "this is right now", and the state could be refined forever
 * but never closed.
 *
 * 'accepted' and 'rejected' ARE terminal. Reopening them would overwrite an
 * attestation already given -- a different feature from refining an unsettled
 * one. Returns null when nothing moved, which the caller distinguishes from
 * "no such proposal" by reading it back.
 */
export async function resolveFilmStudyProposal(input: {
  organizationId: string;
  proposalId: string;
  verdict: FilmStudyProposalVerdict;
  reviewerAccountId: string;
  reviewerRole: PilotRole;
  notes?: string | null;
  correctedObservationText?: string | null;
}): Promise<FilmStudyProposalRow | null> {
  const correctedText = input.correctedObservationText?.trim() ?? '';
  // Checked here rather than left to the constraint so the caller gets a named
  // failure instead of a raw check violation, and so a correction can never be
  // recorded as an empty rewrite that reads as agreement.
  if (input.verdict === 'corrected' && !correctedText) {
    throw new Error('Missing corrected_observation_text for a corrected verdict');
  }
  if (input.verdict !== 'corrected' && correctedText) {
    throw new Error('corrected_observation_text is only valid with a corrected verdict');
  }

  const settled = await queryOne<FilmStudyProposalRow>(
    `update pilot.shadow_film_study_proposals
     set review_state = $3,
         reviewed_by_account_id = $4,
         reviewed_by_role = $5,
         reviewed_at = now(),
         review_notes = $6,
         -- Carried forward on an accept/reject so the wording the coach
         -- finally settled on is not erased by the act of settling. Only a
         -- correction replaces it, and only ever with the newest pass.
         corrected_observation_text = case
           when $3 = 'corrected' then $7
           else corrected_observation_text
         end,
         updated_at = now()
     where organization_id = $1
       and proposal_id = $2
       -- Refining an unsettled proposal, not re-deciding a settled one:
       -- 'corrected' is a working state, 'accepted' and 'rejected' are not.
       and review_state in ('pending_review', 'corrected')
     returning ${PROPOSAL_COLUMNS}`,
    [
      input.organizationId,
      input.proposalId,
      input.verdict,
      input.reviewerAccountId,
      input.reviewerRole,
      input.notes?.slice(0, 2000) ?? null,
      input.verdict === 'corrected' ? correctedText.slice(0, 4000) : null,
    ],
  );

  // Appended only after the row actually moved, so a rejected update (someone
  // else settled it first) cannot leave an orphan revision claiming a pass
  // that never happened.
  if (settled && input.verdict === 'corrected') {
    await query(
      `insert into pilot.film_study_proposal_revisions
         (revision_id, proposal_id, organization_id, revision_number,
          observation_text, revised_by_account_id, revised_by_role, revision_note)
       select $1, $2, $3,
              coalesce(max(revision_number), 0) + 1,
              $4, $5, $6, $7
       from pilot.film_study_proposal_revisions
       where proposal_id = $2`,
      [
        randomUUID(),
        input.proposalId,
        input.organizationId,
        correctedText.slice(0, 4000),
        input.reviewerAccountId,
        input.reviewerRole,
        input.notes?.slice(0, 2000) ?? null,
      ],
    );
  }

  return settled;
}

export interface FilmStudyRevisionRow {
  revision_id: string;
  proposal_id: string;
  revision_number: number;
  observation_text: string;
  revised_by_account_id: string;
  revised_by_role: string;
  revised_at: string;
  revision_note: string | null;
}

/**
 * Every correction pass on one proposal, oldest first.
 *
 * The chain is the point: one-shot correction says the model was wrong, while
 * the sequence says how far wrong it started and what the coach kept changing.
 */
export async function listFilmStudyProposalRevisions(
  organizationId: string,
  proposalId: string,
): Promise<FilmStudyRevisionRow[]> {
  return query<FilmStudyRevisionRow>(
    `select revision_id, proposal_id, revision_number, observation_text,
            revised_by_account_id, revised_by_role, revised_at, revision_note
     from pilot.film_study_proposal_revisions
     where organization_id = $1 and proposal_id = $2
     order by revision_number asc`,
    [organizationId, proposalId],
  );
}

/**
 * The SQL predicate that separates coach-reviewed Film Study material from a
 * queue of unreviewed AI claims, exported so no caller hand-rolls it.
 *
 * 'pending_review' is a vision model's unreviewed claim about an identifiable
 * minor, and 'rejected' is a claim a coach looked at and said no to. NEITHER IS
 * EVIDENCE, and a read model that surfaced either would turn the acceptance
 * gate into decoration. That is the whole safety design of issue #103: vision
 * output never touches an athlete record until a human accepts it.
 *
 * ACCEPTED ONLY -- 'corrected' is excluded, by owner decision (2026-08-27).
 *
 * This was the open question #717 raised rather than settled. 'corrected' is
 * not a settled state: listFilmStudyProposals' working view is
 * `pending_review` + `corrected`, so a corrected proposal has NOT left the
 * coach's queue. A coach has authored replacement wording for the model's
 * claim, which is more than a pending row has -- but it is work in progress,
 * not a verdict, and this predicate is the line that decides what may be read
 * back as evidence about a child. Work in progress does not cross it.
 *
 * The rows are excluded from a READ, never deleted: a corrected proposal
 * remains in the coach's queue, exactly where it is still owed a decision.
 */
export const REVIEWED_FILM_STUDY_SCOPE_SQL = "review_state = 'accepted'";

export type ReviewedFilmStudyState = Extract<FilmStudyProposalReviewState, 'accepted'>;

/**
 * One piece of Film Study material a coach has actually worked on.
 *
 * Deliberately NOT a narrowed FilmStudyProposalRow: the fields kept here are
 * the ones a reader needs in order to tell whose claim this is and what it was
 * based on. Nothing is merged -- `observation_text` and
 * `corrected_observation_text` stay separate, and `origin` is never collapsed.
 */
export interface ReviewedFilmStudyRow {
  proposal_id: string;
  organization_id: string;
  athlete_id: string;
  video_session_id: string;
  /** Never collapsed. 'model_proposed' is what the vision model claimed;
   * 'coach_reported' is what the model MISSED and a coach entered by hand.
   * Flattened together, an accepted missed-detection reads as the model
   * succeeding -- the exact inversion MODEL_PROPOSAL_SCOPE_SQL exists to
   * prevent in the validation figures. */
  origin: FilmStudyProposalOrigin;
  /** 'accepted' is settled. 'corrected' IS NOT: a corrected proposal is still
   * in the coach's working queue (see listFilmStudyProposals) and can still be
   * accepted or rejected. It is included here because a coach has authored its
   * replacement wording, which a pending proposal has not -- but it is carried
   * verbatim, never as "reviewed", so a reader can see which it is. */
  review_state: ReviewedFilmStudyState;
  /** The ORIGINAL wording, never overwritten -- on a corrected row this is
   * still what the model said. */
  observation_text: string;
  /** The coach's replacement wording. Present only on a corrected row. Both
   * texts travel together: the model said X, the coach made it Y, and carrying
   * one without the other makes the model look either right or absent. */
  corrected_observation_text: string | null;
  evidence_id: string;
  /** Null exactly when origin is 'coach_reported' -- there was no inference run
   * to name. The database enforces that. */
  model_deployment: string | null;
  frames_analyzed: number | null;
  /** Null exactly when origin is 'model_proposed'. */
  reported_by_account_id: string | null;
  reviewed_by_account_id: string | null;
  reviewed_by_role: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const REVIEWED_COLUMNS = `
  proposal_id, organization_id, athlete_id, video_session_id, origin, review_state,
  observation_text, corrected_observation_text, evidence_id, model_deployment,
  frames_analyzed, reported_by_account_id, reviewed_by_account_id, reviewed_by_role,
  reviewed_at, created_at, updated_at
`;

/**
 * Film Study material for ONE athlete that a coach has accepted or corrected.
 *
 * `listFilmStudyProposals` cannot serve this: its working view is
 * `review_state in ('pending_review','corrected')` -- the queue of what still
 * needs a coach -- which is the precise opposite of what may be read back as
 * evidence. `getFilmStudyValidation` cannot either: it measures the MODEL over
 * a whole organization and says nothing about any athlete.
 *
 * `athleteId` IS REQUIRED. `listFilmStudyProposals` returns the entire
 * organization when it is omitted, and this reader has no such mode -- there is
 * no argument list that reads another child's film by accident.
 *
 * This is a filter on a READ. Nothing here deletes, hides or settles a row: a
 * pending proposal still reaches the coach's queue, and a rejected one stays as
 * the record that the model was wrong.
 */
export async function listReviewedFilmStudyMaterial(input: {
  organizationId: string;
  athleteId: string;
  limit?: number;
}): Promise<ReviewedFilmStudyRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  return query<ReviewedFilmStudyRow>(
    `select ${REVIEWED_COLUMNS}
     from pilot.shadow_film_study_proposals
     where organization_id = $1
       and athlete_id = $2
       and ${REVIEWED_FILM_STUDY_SCOPE_SQL}
     order by reviewed_at desc nulls last, created_at desc
     limit ${limit}`,
    [input.organizationId, input.athleteId],
  );
}
