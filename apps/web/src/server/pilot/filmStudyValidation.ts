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
  /** Still awaiting a coach, never opened. Never counted toward the rate: an
   * unreviewed proposal is not evidence of anything, and folding pending rows
   * in would drag every rate toward whatever the queue depth happened to be. */
  pendingCount: number;
  /**
   * Proposals a coach CORRECTED -- the model saw something real and described
   * it wrong.
   *
   * Counted by nothing until 2026-08-27. review_state has four values and
   * every filter here named three of them, so a corrected row was in no count
   * at all -- while listFilmStudyProposals treated it as still outstanding
   * (its working view is `in ('pending_review','corrected')`). Two shipped
   * reads disagreed about the same row and the one an operator reads reported
   * it as though it did not exist.
   *
   * It is deliberately NOT folded into reviewedCount. A correction is neither
   * an acceptance nor a rejection, and reviewedCount is already on a coach's
   * screen meaning "settled as accepted or rejected"; changing what an existing
   * number counts is how a chart quietly starts saying something else.
   */
  correctedCount: number;
  /**
   * Distinct proposals that needed correcting AT ANY POINT, from the revision
   * ledger rather than the current state.
   *
   * `corrected` is NOT terminal -- resolveFilmStudyProposal admits
   * `in ('pending_review','corrected')` -- so a coach who corrects a proposal
   * and then accepts it moves review_state off 'corrected' entirely. Counting
   * the state alone therefore DROPS the correction, and the correction rate
   * improves because the coach finished the queue rather than because the
   * model got better. That is the opposite of what the metric means, so the
   * rate below is computed from this, not from correctedCount.
   *
   * Distinct PROPOSALS, not revisions: a proposal corrected twice is one
   * proposal the model got wrong, not two.
   */
  everCorrectedCount: number;
  /**
   * What a coach still has to open: pending plus corrected.
   *
   * `corrected` is not terminal -- the update guard in shadowFilmStudyProposals
   * admits `in ('pending_review','corrected')` and each pass appends a
   * revision -- so a corrected proposal is genuinely still in the queue. This
   * is the number that agrees with listFilmStudyProposals.
   */
  outstandingCount: number;
  /**
   * Every model proposal in scope, whatever its state. The denominator for the
   * three rates below, named rather than implied: a rate whose denominator a
   * reader has to infer is a rate they will infer wrongly.
   */
  modelProposalCount: number;
  /** accepted / modelProposalCount. Null below the sample floor. */
  acceptanceRateAmongProposals: number | null;
  /** everCorrected / modelProposalCount. Null below the sample floor.
   * Uses the history count, so finishing the queue cannot improve it. */
  correctionRateAmongProposals: number | null;
  /** rejected / modelProposalCount. Null below the sample floor. */
  rejectionRateAmongProposals: number | null;
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

/**
 * The literal the order requires wherever a rate has no defensible denominator.
 *
 * Not null, and not omitted. A null reads as "not measured yet" and an absent
 * key reads as an oversight; both invite someone to fill it in later. This says
 * the measurement is not available from this data, which is a different and
 * permanent fact until the schema changes.
 */
export const DENOMINATOR_NOT_CAPTURED = 'UNAVAILABLE — DENOMINATOR_NOT_CAPTURED' as const;

export interface FilmStudyValidationReport {
  organizationId: string;
  minimumReviewed: number;
  /**
   * Observations a coach entered that the model did not propose -- what a
   * coach CLAIMS the model failed to see. Includes reports still awaiting
   * review and reports another coach rejected; see
   * coachReportedConfirmedCount for the ones a reviewer confirmed.
   *
   * Reported beside the model's numbers and excluded from all of them. It is
   * org-scoped rather than per-deployment because a coach report has no
   * inference run to attribute it to: the provenance CHECK constraint requires
   * model_deployment to be NULL on exactly these rows.
   */
  coachReportedCount: number;
  /**
   * Coach reports a reviewer ACCEPTED -- the confirmed misses.
   *
   * coachReportedCount above is every report entered, including ones still
   * awaiting review and ones another coach REJECTED. A mistaken report that
   * was rejected is not evidence the model missed anything, and counting it
   * as such would permanently inflate the number the report describes as the
   * false-negative record. Both are given because they answer different
   * questions: what was claimed, and what was confirmed.
   */
  coachReportedConfirmedCount: number;
  /**
   * ALWAYS the unavailable literal.
   *
   * A missed-observation rate needs to know how many observations COULD have
   * been made, and nothing records that. There is no opportunity column on
   * either Film Study table, no duration or frame count on pilot.video_sessions,
   * and the pipeline writes exactly one proposal per job (enforced by
   * uq_film_study_proposals_job) -- so the proposal count is a proxy for the
   * VIDEO count, not for observation opportunities.
   *
   * coachReportedCount over modelProposalCount would therefore be a ratio of
   * two things that do not share a denominator. The coach-reported migration's
   * own header says it: any accept rate computed from these rows "is blind to
   * false negatives by construction, because there is no way to enter one."
   *
   * This field exists so the absence is stated where the number would be, and
   * so nobody computes the ratio because it looked computable.
   */
  missedObservationRate: typeof DENOMINATOR_NOT_CAPTURED;
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
  corrected_count: string;
  ever_corrected_count: string;
  proposal_count: string;
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
/** A rate over a named denominator, withheld when the denominator is empty. */
function rateOver(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function toMetric(row: AcceptanceRow): FilmStudyAcceptanceMetric {
  const reviewedCount = toInt(row.reviewed_count);
  const acceptedCount = toInt(row.accepted_count);
  const rejectedCount = toInt(row.rejected_count);
  const pendingCount = toInt(row.pending_count);
  const correctedCount = toInt(row.corrected_count);
  const everCorrectedCount = toInt(row.ever_corrected_count);
  const modelProposalCount = toInt(row.proposal_count);

  const belowFloor = reviewedCount < FILM_STUDY_MINIMUM_REVIEWED;
  // The among-proposals rates use their own floor: their denominator is every
  // proposal, not just settled ones, so a queue of 40 pending and 2 settled
  // has plenty of denominator while `reviewedCount` is still 2. Withholding
  // them on the settled floor would hide the very number that says the queue
  // is not being worked.
  const proposalsBelowFloor = modelProposalCount < FILM_STUDY_MINIMUM_REVIEWED;

  return {
    status: belowFloor ? 'insufficient_data' : 'available',
    reviewedCount,
    acceptedCount,
    rejectedCount,
    pendingCount,
    correctedCount,
    everCorrectedCount,
    outstandingCount: pendingCount + correctedCount,
    modelProposalCount,
    acceptRate: belowFloor
      ? null
      : Math.round((acceptedCount / reviewedCount) * 1000) / 1000,
    acceptRateDisplay: belowFloor
      ? null
      : formatAcceptRatePercent(acceptedCount, reviewedCount),
    acceptanceRateAmongProposals: proposalsBelowFloor
      ? null
      : rateOver(acceptedCount, modelProposalCount),
    correctionRateAmongProposals: proposalsBelowFloor
      ? null
      : rateOver(everCorrectedCount, modelProposalCount),
    rejectionRateAmongProposals: proposalsBelowFloor
      ? null
      : rateOver(rejectedCount, modelProposalCount),
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
    count(*) filter (where review_state = 'corrected')::text as corrected_count,
    -- Distinct proposals carrying at least one revision: "was ever corrected",
    -- which survives the proposal being finished. EXISTS rather than a join so
    -- a proposal corrected twice counts once.
    count(*) filter (
      where exists (
        select 1 from pilot.film_study_proposal_revisions r
        where r.organization_id = p.organization_id
          and r.proposal_id = p.proposal_id
      )
    )::text as ever_corrected_count,
    count(*)::text as proposal_count,
    avg(frames_analyzed) filter (where review_state in ('accepted', 'rejected'))::text as mean_frames
  from pilot.shadow_film_study_proposals p
  where organization_id = $1
    and ${MODEL_PROPOSAL_SCOPE_SQL}
`;

/* Coach reports are excluded from both queries above by MODEL_PROPOSAL_SCOPE_SQL,
   so counting them needs its own read rather than another filter there. Kept
   separate deliberately: it is a different question (what did the model miss)
   and merging it into a query about model proposals is how the two got
   conflated in the first place. */
const COACH_REPORTED_SQL = `
  select
    count(*)::text as coach_reported_count,
    count(*) filter (where review_state = 'accepted')::text as coach_reported_confirmed_count
  from pilot.shadow_film_study_proposals
  where organization_id = $1
    and origin = 'coach_reported'
`;

const BY_DEPLOYMENT_SQL = `
  select
    model_deployment,
    count(*) filter (where review_state in ('accepted', 'rejected'))::text as reviewed_count,
    count(*) filter (where review_state = 'accepted')::text as accepted_count,
    count(*) filter (where review_state = 'rejected')::text as rejected_count,
    count(*) filter (where review_state = 'pending_review')::text as pending_count,
    count(*) filter (where review_state = 'corrected')::text as corrected_count,
    -- Distinct proposals carrying at least one revision: "was ever corrected",
    -- which survives the proposal being finished. EXISTS rather than a join so
    -- a proposal corrected twice counts once.
    count(*) filter (
      where exists (
        select 1 from pilot.film_study_proposal_revisions r
        where r.organization_id = p.organization_id
          and r.proposal_id = p.proposal_id
      )
    )::text as ever_corrected_count,
    count(*)::text as proposal_count,
    avg(frames_analyzed) filter (where review_state in ('accepted', 'rejected'))::text as mean_frames
  from pilot.shadow_film_study_proposals p
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
  const [overallRows, deploymentRows, coachReportedRows] = await Promise.all([
    query<AcceptanceRow>(OVERALL_SQL, [organizationId]),
    query<AcceptanceRow>(BY_DEPLOYMENT_SQL, [organizationId]),
    query<{ coach_reported_count: string; coach_reported_confirmed_count: string }>(
      COACH_REPORTED_SQL,
      [organizationId],
    ),
  ]);

  const overallRow = overallRows[0] ?? {
    model_deployment: null,
    reviewed_count: '0',
    accepted_count: '0',
    rejected_count: '0',
    pending_count: '0',
    corrected_count: '0',
    ever_corrected_count: '0',
    proposal_count: '0',
    mean_frames: null,
  };

  return {
    organizationId,
    minimumReviewed: FILM_STUDY_MINIMUM_REVIEWED,
    coachReportedCount: toInt(coachReportedRows[0]?.coach_reported_count ?? '0'),
    coachReportedConfirmedCount: toInt(
      coachReportedRows[0]?.coach_reported_confirmed_count ?? '0',
    ),
    missedObservationRate: DENOMINATOR_NOT_CAPTURED,
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
    // outstandingCount, not pendingCount. A proposal a coach CORRECTED but has
    // not finished has reviewedCount 0 and pendingCount 0, and this branch used
    // to answer "no proposals exist yet" -- a false absence claim, about the
    // one thing this module exists to refuse to claim, sent straight to the
    // coach page by the validation route.
    return overall.outstandingCount > 0
      ? `No Film Study proposal has been reviewed yet (${overall.outstandingCount} outstanding).`
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
    + `${overall.outstandingCount > 0 ? `, ${overall.outstandingCount} still outstanding` : ''}.`;
}
