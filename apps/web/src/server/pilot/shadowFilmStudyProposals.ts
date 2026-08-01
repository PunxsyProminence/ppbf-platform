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

export type FilmStudyProposalReviewState = 'pending_review' | 'accepted' | 'rejected';
export type FilmStudyProposalVerdict = Extract<FilmStudyProposalReviewState, 'accepted' | 'rejected'>;

export interface FilmStudyProposalRow {
  proposal_id: string;
  organization_id: string;
  athlete_id: string;
  video_session_id: string;
  job_id: string | null;
  observation_text: string;
  evidence_id: string;
  model_deployment: string;
  frames_analyzed: number;
  review_state: FilmStudyProposalReviewState;
  reviewed_by_account_id: string | null;
  reviewed_by_role: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
}

const PROPOSAL_COLUMNS = `
  proposal_id, organization_id, athlete_id, video_session_id, job_id,
  observation_text, evidence_id, model_deployment, frames_analyzed,
  review_state, reviewed_by_account_id, reviewed_by_role, reviewed_at,
  review_notes, created_at, updated_at
`;

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
        observation_text, evidence_id, model_deployment, frames_analyzed)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
 * BOTH verdicts are always reachable from pending_review, and nothing about
 * the proposal's content can block either one -- an observation the coach
 * disagrees with is exactly what 'rejected' is for. That is the C1/C2 lesson
 * (#122) encoded as a rule rather than relearned.
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
}): Promise<FilmStudyProposalRow | null> {
  return queryOne<FilmStudyProposalRow>(
    `update pilot.shadow_film_study_proposals
     set review_state = $3,
         reviewed_by_account_id = $4,
         reviewed_by_role = $5,
         reviewed_at = now(),
         review_notes = $6,
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
    ],
  );
}
