import { query } from './db';
import { MODEL_PROPOSAL_SCOPE_SQL } from './shadowFilmStudyProposals';

// Film Study model validation -- how often a coach actually accepts what the
// vision model proposed.
//
// WHY THIS EXISTS. pilot.shadow_film_study_proposals already records both
// halves of a measurement and nothing ever computed it: the model's claim
// (observation_text, model_deployment, frames_analyzed) and the coach's
// verdict (review_state accepted/rejected, with an attestation the table's own
// CHECK constraint enforces). Every settled MODEL proposal is one labelled
// example, produced by this gym's own coaches on this gym's own footage. The
// accept rate over those is the validation -- it has been accumulating in the
// database the whole time, uncomputed.
//
// MODEL PROPOSALS ONLY. The same table also holds coach-reported observations:
// what the model MISSED. Those are excluded from every figure here, for the
// reason written above OVERALL_SQL below. They are not deleted and must not be
// -- they are the false-negative record, and the only evidence this platform
// has of what the model failed to see.
//
// That matters more than a benchmark number from a paper. A published
// accuracy figure describes somebody else's athletes, camera, and lighting.
// This describes yours, and it updates every time a coach clears the queue.
//
// WHAT THIS IS NOT. It is not a skill score, and it says nothing about any
// athlete. It measures the MODEL. A low accept rate means the queue is wasting
// a coach's time; a high one means the queue is worth opening. Neither is a
// statement about a boxer.
//
// NO INVENTED CONFIDENCE. Rates are counts divided by counts, reported beside
// the counts they came from, and withheld entirely below a sample floor. Two
// accepted proposals out of two is not "100% accurate" and this module will
// not say it is.

/** Settled proposals required before a rate is reported at all.
 *
 * Same posture and the same number as BOARD_MINIMUM_COHORT_SIZE: below it the
 * status is `insufficient_data` and every figure is null, because a rate over
 * three reviews reads as precision the sample cannot support. Held separately
 * from the board constant because the two answer different questions and
 * should be tunable apart. */
export const FILM_STUDY_MINIMUM_REVIEWED = 5;

export type FilmStudyValidationStatus = 'available' | 'insufficient_data';

export interface FilmStudyAcceptanceMetric {
  status: FilmStudyValidationStatus;
  /** Settled (accepted + rejected) proposals. Always reported -- a caller must
   * be able to see how thin the sample is even when the rate is withheld. */
  reviewedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  /** Still awaiting a coach. Never counted toward the rate: an unreviewed
   * proposal is not evidence of anything, and folding pending rows in would
   * drag every rate toward whatever the queue depth happened to be. */
  pendingCount: number;
  /** accepted / reviewed, rounded to 3 places. Null below the sample floor. */
  acceptRate: number | null;
  /** The rate as a percentage string, ready to render. Null wherever
   * `acceptRate` is null.
   *
   * Computed here rather than in the UI so there is exactly one implementation
   * of the rule below, and so a client component never has to recompute it. */
  acceptRateDisplay: string | null;
}

export interface FilmStudyDeploymentAcceptance extends FilmStudyAcceptanceMetric {
  modelDeployment: string;
  /** Mean frames the model saw, over settled proposals. A proposal built from
   * 3 frames is not the same claim as one built from 90, and a deployment
   * whose accept rate moves with frame count is telling you something. Null
   * when no settled proposal exists to average. */
  meanFramesAnalyzed: number | null;
}

export interface FilmStudyValidationReport {
  organizationId: string;
  minimumReviewed: number;
  /** Every settled proposal in the organization, all deployments together. */
  overall: FilmStudyAcceptanceMetric;
  /** Per deployment, most-reviewed first. This is the comparison that decides
   * whether a model change helped: two deployments, two accept rates, same
   * coaches. */
  byDeployment: FilmStudyDeploymentAcceptance[];
}

interface AcceptanceRow {
  model_deployment: string | null;
  reviewed_count: string;
  accepted_count: string;
  rejected_count: string;
  pending_count: string;
  mean_frames: string | null;
}

function toInt(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The accept rate as a percentage, where 0% and 100% are reserved.
 *
 * `Math.round(rate * 100)` is wrong in both directions at the ends, and the
 * error is categorical rather than cosmetic. 199 accepted of 200 rounds to
 * "100% accepted" -- a claim the model was never once wrong, contradicted by
 * the rejection sitting in the same table. 1 accepted of 300 rounds to "0%" --
 * a claim the model was never once right, contradicted by the acceptance.
 * Those two readings are the only ones a coach will act on without reading the
 * counts beside them, so they are spent only on the exact cases:
 *
 * * `0%`   -- nothing was accepted.
 * * `100%` -- nothing was rejected.
 * * `<1%`  -- something was accepted, too little to round up to 1%.
 * * `>99%` -- something was rejected, too little to round down to 99%.
 *
 * Null when nothing has been reviewed; there is no rate to describe.
 */
export function formatAcceptRatePercent(
  acceptedCount: number,
  reviewedCount: number,
): string | null {
  if (reviewedCount <= 0) return null;
  if (acceptedCount <= 0) return '0%';
  if (acceptedCount >= reviewedCount) return '100%';

  const rounded = Math.round((acceptedCount / reviewedCount) * 100);
  if (rounded <= 0) return '<1%';
  if (rounded >= 100) return '>99%';
  return `${rounded}%`;
}

/** Builds one metric, withholding the rate below the sample floor. */
function toMetric(row: AcceptanceRow): FilmStudyAcceptanceMetric {
  const reviewedCount = toInt(row.reviewed_count);
  const acceptedCount = toInt(row.accepted_count);
  const rejectedCount = toInt(row.rejected_count);
  const pendingCount = toInt(row.pending_count);

  const belowFloor = reviewedCount < FILM_STUDY_MINIMUM_REVIEWED;

  return {
    status: belowFloor ? 'insufficient_data' : 'available',
    reviewedCount,
    acceptedCount,
    rejectedCount,
    pendingCount,
    acceptRate: belowFloor
      ? null
      : Math.round((acceptedCount / reviewedCount) * 1000) / 1000,
    acceptRateDisplay: belowFloor
      ? null
      : formatAcceptRatePercent(acceptedCount, reviewedCount),
  };
}

/* ONLY MODEL PROPOSALS. `pilot.shadow_film_study_proposals` holds two kinds of
   row, and only one of them is the model's claim.

   A `coach_reported` row is an observation the model MISSED -- the queue's
   missed-detection path. A coach accepting one is confirmation the model was
   WRONG, so counting it as an acceptance inverts its meaning and inflates the
   very number that path exists to keep honest. Both queries counted every
   settled row until 2026-08-23, which made "coaches accepted 6 of 8" out of a
   model that went 3 for 5.

   The predicate is imported, not retyped. shadowFilmStudyProposals.ts owns it
   and documents why it exists; a second copy here would be free to drift from
   the definition it is supposed to be enforcing.

   COACH REPORTS ARE NOT DELETED, ONLY EXCLUDED FROM THIS METRIC. They are the
   only record of what the model failed to see, which makes them the most
   valuable rows in the table for judging it. They are filtered out of an
   answer about model proposals because they are not model proposals. */
const OVERALL_SQL = `
  select
    null::text as model_deployment,
    count(*) filter (where review_state in ('accepted', 'rejected'))::text as reviewed_count,
    count(*) filter (where review_state = 'accepted')::text as accepted_count,
    count(*) filter (where review_state = 'rejected')::text as rejected_count,
    count(*) filter (where review_state = 'pending_review')::text as pending_count,
    avg(frames_analyzed) filter (where review_state in ('accepted', 'rejected'))::text as mean_frames
  from pilot.shadow_film_study_proposals
  where organization_id = $1
    and ${MODEL_PROPOSAL_SCOPE_SQL}
`;

const BY_DEPLOYMENT_SQL = `
  select
    model_deployment,
    count(*) filter (where review_state in ('accepted', 'rejected'))::text as reviewed_count,
    count(*) filter (where review_state = 'accepted')::text as accepted_count,
    count(*) filter (where review_state = 'rejected')::text as rejected_count,
    count(*) filter (where review_state = 'pending_review')::text as pending_count,
    avg(frames_analyzed) filter (where review_state in ('accepted', 'rejected'))::text as mean_frames
  from pilot.shadow_film_study_proposals
  where organization_id = $1
    and ${MODEL_PROPOSAL_SCOPE_SQL}
  group by model_deployment
  order by count(*) filter (where review_state in ('accepted', 'rejected')) desc, model_deployment asc
`;

/**
 * How often this organization's coaches accepted what the model proposed.
 *
 * Organization-scoped by the caller's session, like every other read here --
 * one gym's coaches validating one gym's model runs. There is no cross-gym
 * aggregate and there should not be: a shared accept rate would average over
 * different cameras, rooms, and coaching standards and mean nothing.
 */
export async function getFilmStudyValidation(
  organizationId: string,
): Promise<FilmStudyValidationReport> {
  const [overallRows, deploymentRows] = await Promise.all([
    query<AcceptanceRow>(OVERALL_SQL, [organizationId]),
    query<AcceptanceRow>(BY_DEPLOYMENT_SQL, [organizationId]),
  ]);

  const overallRow = overallRows[0] ?? {
    model_deployment: null,
    reviewed_count: '0',
    accepted_count: '0',
    rejected_count: '0',
    pending_count: '0',
    mean_frames: null,
  };

  return {
    organizationId,
    minimumReviewed: FILM_STUDY_MINIMUM_REVIEWED,
    overall: toMetric(overallRow),
    byDeployment: deploymentRows.map((row) => {
      const meanFrames = row.mean_frames === null ? null : Number(row.mean_frames);
      return {
        // The column IS nullable -- it is null on exactly the coach-reported
        // rows, which have no inference run to name. Those are excluded above,
        // so within this scope a deployment is always present and the coalesce
        // is unreachable. It is kept rather than removed because 'unknown' is
        // the visible symptom if the origin filter is ever dropped again: a
        // phantom deployment appearing beside the real ones in an operator's
        // comparison. filmStudyValidationOriginScope.pg.test.ts asserts it
        // does not appear.
        modelDeployment: row.model_deployment ?? 'unknown',
        ...toMetric(row),
        meanFramesAnalyzed:
          meanFrames === null || !Number.isFinite(meanFrames)
            ? null
            : Math.round(meanFrames * 10) / 10,
      };
    }),
  };
}

/**
 * One line an operator can read without interpreting a table.
 *
 * Says the sample size in the same breath as the rate, every time. A bare
 * "62% accepted" invites a reader to treat eight reviews as a finding.
 */
export function describeFilmStudyValidation(report: FilmStudyValidationReport): string {
  const { overall } = report;

  if (overall.reviewedCount === 0) {
    return overall.pendingCount > 0
      ? `No Film Study proposal has been reviewed yet (${overall.pendingCount} waiting).`
        + ' Nothing can be said about the model until coaches clear the queue.'
      : 'No Film Study proposals exist yet -- the model has not been asked for anything.';
  }

  if (overall.status === 'insufficient_data') {
    return `Only ${overall.reviewedCount} proposal(s) reviewed, below the ${report.minimumReviewed} needed`
      + ' to report a rate. The accept rate is withheld rather than computed from a sample this thin.';
  }

  // `available` means the sample cleared the floor, so a display string always
  // exists here. The fallback drops the parenthetical rather than printing an
  // empty one -- the counts alone are still true.
  const percent = overall.acceptRateDisplay === null ? '' : ` (${overall.acceptRateDisplay})`;
  return `Coaches accepted ${overall.acceptedCount} of ${overall.reviewedCount} reviewed proposals${percent}`
    + `${overall.pendingCount > 0 ? `, ${overall.pendingCount} still waiting` : ''}.`;
}
