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
       and ($2::text = 'all' or review_state = 'pending_review')
       and ($3::text is null or athlete_id = $3)
     order by
       case when review_state = 'pending_review' then 0 else 1 end,
       case when review_state = 'pending_review' then created_at end asc,
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
 * Settle a proposal: the human attestation the safety design requires.
 *
 * ALL THREE verdicts are always reachable from pending_review, and nothing
 * about the proposal's content can block any of them -- an observation the
 * coach disagrees with is exactly what 'rejected' is for. That is the C1/C2
 * lesson (#122) encoded as a rule rather than relearned.
 *
 * 'corrected' exists because rejection was previously the only thing a coach
 * who was nearly in agreement could reach, and it discarded what they knew.
 * A correction carries the coach's replacement wording alongside the model's
 * original, which is never overwritten -- both readings survive, so a later
 * reader can see what the model said and what the coach made of it.
 *
 * Only a pending proposal can be settled: re-deciding a settled one would
 * overwrite who attested to it. Returns null when nothing was settled, which
 * the caller distinguishes from "no such proposal" by reading it back.
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

  return queryOne<FilmStudyProposalRow>(
    `update pilot.shadow_film_study_proposals
     set review_state = $3,
         reviewed_by_account_id = $4,
         reviewed_by_role = $5,
         reviewed_at = now(),
         review_notes = $6,
         corrected_observation_text = $7,
         updated_at = now()
     where organization_id = $1
       and proposal_id = $2
       and review_state = 'pending_review'
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
}
