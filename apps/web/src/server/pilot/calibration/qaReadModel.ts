import type { AdjudicationRow } from './adjudication';
import type { AnnotationEventRow, AnnotationSetRow } from './annotations';
import {
  DISAGREEMENT_CATEGORIES,
  type AnnotationSetComparison,
  type DisagreementCategory,
} from './comparison';

// The calibration QA read-out: how the ANNOTATION SYSTEM is behaving.
//
// WHAT THIS EVALUATES. The vocabulary, the footage, and the process by which
// two people apply the first to the second. That is all.
//
// WHAT IT MUST NEVER EVALUATE, and what this module is built to make awkward:
//
//   * ANY ATHLETE. No boxer score, no performance conclusion. Nothing here is
//     keyed by athlete and nothing here should be.
//   * ANY ANNOTATOR. There is deliberately no per-annotator breakdown
//     anywhere in the output, and a test asserts no annotator account id
//     appears in the serialized report. The data could trivially produce one;
//     an annotator leaderboard would turn a measurement exercise into a
//     performance review, and coaches would start labelling to agree with
//     each other rather than to record what they saw -- which would destroy
//     the very signal the study exists to collect.
//   * THE MODEL. Annotator agreement is not model accuracy. Nothing here
//     touches Film Study.
//
// NO SINGLE NUMBER. There is no "ontology confidence", no overall agreement
// score, and no scalar summarising the study. Fifteen disagreement categories
// mean fifteen different things and collapsing them needs weights nobody has
// measured.
//
// EVERY RATE CARRIES ITS DENOMINATOR, and they are not all the same one. A
// field disagreement can only happen on a pair that MATCHED; a missed event
// by definition did not match. Dividing both by the same number would be
// arithmetic that reads as a finding. Each rate below names the denominator
// it used and reports the count beside it.

/** Comparisons required before any rate is reported at all.
 *
 * Same posture and the same number as FILM_STUDY_MINIMUM_REVIEWED and
 * BOARD_MINIMUM_COHORT_SIZE: below it every rate is null and the status is
 * `insufficient_data`, because a disagreement rate over three comparisons
 * reads as precision the sample cannot support. Held separately from those
 * constants because it answers a different question and should be tunable
 * apart.
 *
 * NOT a scientific threshold. It is the smallest sample that is not
 * self-evidently too small to describe, and choosing the real one is an owner
 * decision this module does not make. */
export const CALIBRATION_MINIMUM_COMPARISONS = 5;

/** The marker used wherever a figure cannot be computed because the platform
 * does not capture what it would need. Reused verbatim from
 * filmStudyValidation so an operator meets one phrase, not two. */
export const DENOMINATOR_NOT_CAPTURED = 'UNAVAILABLE — DENOMINATOR_NOT_CAPTURED' as const;

export type QaStatus = 'available' | 'insufficient_data';

/** A count, the denominator it was counted against, and the rate -- withheld
 * below the sample floor rather than computed from a sample too thin to
 * describe. The denominator is NAMED, not just numbered, because "8 of 40"
 * means nothing until you know what the 40 were. */
export interface RateWithDenominator {
  count: number;
  denominator: number;
  /** What the denominator counts. Rendered beside the rate, always. */
  denominatorKind: string;
  rate: number | null;
}

/**
 * A distribution of boundary deltas, summarised WITHOUT bucketing.
 *
 * NO HISTOGRAM BUCKETS, deliberately. Bucket edges are thresholds, and
 * choosing "within 100ms / 100-250ms / over 250ms" would be inventing exactly
 * the calibrated numbers this build is not authorized to invent -- and the
 * edges would then be read as meaningful categories.
 *
 * SIGNED AND ABSOLUTE ARE BOTH REPORTED, because they answer different
 * questions. If one annotator is consistently 40ms later than the other, the
 * signed median is 40 and the absolute median is 40 -- a systematic offset. If
 * they scatter symmetrically by 40ms, the signed median is near 0 and the
 * absolute median is 40 -- noise. Reporting only the signed figure would make
 * the second case look like agreement.
 */
export interface DeltaSummary {
  count: number;
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
  /** Median of |A - B|. The one to read when asking "how far apart were they". */
  medianAbsoluteMs: number | null;
}

export interface ClipProgress {
  totalClips: number;
  clipsNotStarted: number;
  clipsAwaitingSecondAnnotator: number;
  clipsAwaitingSecondSubmission: number;
  clipsReadyToCompare: number;
  clipsWithAdjudication: number;
}

export interface CalibrationQaReport {
  organizationId: string;
  calibrationProjectId: string;
  ontologyVersion: string;
  minimumComparisons: number;
  status: QaStatus;
  comparisonCount: number;
  clipProgress: ClipProgress;
  disagreementCounts: Record<DisagreementCategory, number>;
  disagreementRates: Record<DisagreementCategory, RateWithDenominator>;
  boundaryDeltas: {
    start_ms: DeltaSummary;
    contact_ms: DeltaSummary;
    end_ms: DeltaSummary;
  };
  unknownRate: RateWithDenominator;
  hedgedCertaintyRate: RateWithDenominator;
  adjudicationRate: RateWithDenominator;
  unresolvableRate: RateWithDenominator;
  strata: {
    bySamplingReason: Record<string, Record<DisagreementCategory, number>>;
    byVisibility: Record<string, Record<DisagreementCategory, number>>;
    byEventClass: Record<string, Record<DisagreementCategory, number>>;
    /** NOT DERIVABLE IN v0.1. An event records only the ACTOR's stance; the
     * opponent's stance lives on the opponent's own event, which the other
     * annotator may never have recorded. A "stance matchup" therefore has no
     * honest denominator, and this says so rather than computing one from the
     * subset where both happen to exist -- that subset is not a random sample
     * of exchanges, it is the exchanges busy enough for both fighters to have
     * been annotated. */
    byStanceMatchup: typeof DENOMINATOR_NOT_CAPTURED;
  };
}

function emptyCounts(): Record<DisagreementCategory, number> {
  return Object.fromEntries(DISAGREEMENT_CATEGORIES.map((category) => [category, 0])) as Record<
    DisagreementCategory,
    number
  >;
}

/** Withholds the rate below the floor rather than computing one. */
function makeRate(
  count: number,
  denominator: number,
  denominatorKind: string,
  belowFloor: boolean,
): RateWithDenominator {
  return {
    count,
    denominator,
    denominatorKind,
    rate: belowFloor || denominator <= 0 ? null : Math.round((count / denominator) * 1000) / 1000,
  };
}

/**
 * The lower median of a sorted list.
 *
 * Deliberately NOT the mean. One annotator who mis-clicked a boundary by
 * fifteen seconds would move a mean enough to describe the whole study, and
 * boundary deltas are exactly where that kind of slip happens. For an even
 * count this takes the lower of the two central values rather than averaging
 * them, so every reported figure is a delta somebody actually produced rather
 * than a number that appears nowhere in the data.
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function summariseDeltas(deltas: readonly number[]): DeltaSummary {
  if (deltas.length === 0) {
    return { count: 0, minMs: null, medianMs: null, maxMs: null, medianAbsoluteMs: null };
  }
  return {
    count: deltas.length,
    minMs: Math.min(...deltas),
    medianMs: median(deltas),
    maxMs: Math.max(...deltas),
    medianAbsoluteMs: median(deltas.map((delta) => Math.abs(delta))),
  };
}

/** The ontology fields whose 'unknown' member is a recorded observation.
 *
 * Only these. `contact_zone` has BOTH 'unknown' and 'none', and only the first
 * is an unobservable outcome -- 'none' is an observed miss. Counting 'none' as
 * unknown would turn clean observations of misses into evidence the footage
 * was unreadable. */
const UNKNOWN_BEARING_FIELDS = [
  'physical_hand',
  'hand_role',
  'stance',
  'target_zone',
  'contact_zone',
] as const;

function countUnknownValues(events: readonly AnnotationEventRow[]): {
  unknown: number;
  recorded: number;
} {
  let unknown = 0;
  let recorded = 0;
  for (const event of events) {
    for (const field of UNKNOWN_BEARING_FIELDS) {
      const value = event[field];
      // A null is "not recorded", which is a different fact from "recorded as
      // unobservable". Only the latter belongs in this rate, and neither
      // belongs in the denominator of the other.
      if (value === null) continue;
      recorded += 1;
      if (value === 'unknown') unknown += 1;
    }
  }
  return { unknown, recorded };
}

export interface BuildQaReportInput {
  organizationId: string;
  calibrationProjectId: string;
  ontologyVersion: string;
  /** Every clip in the project, with the stratum it was sampled for. */
  clips: ReadonlyArray<{ calibration_clip_id: string; primary_sampling_reason: string }>;
  /** Every annotation set across those clips, in any state. */
  sets: readonly AnnotationSetRow[];
  /** Every event in every SUBMITTED set. */
  events: readonly AnnotationEventRow[];
  /** One comparison per clip where both sets are submitted. */
  comparisons: readonly AnnotationSetComparison[];
  adjudications: readonly AdjudicationRow[];
  minimumComparisons?: number;
}

/**
 * Builds the QA read-out.
 *
 * PURE. No I/O, no clock, no randomness -- the same inputs give the same
 * report, which is what lets this be recomputed on read rather than stored.
 * Its inputs are all frozen or derived from frozen rows.
 */
export function buildCalibrationQaReport(input: BuildQaReportInput): CalibrationQaReport {
  const minimumComparisons = input.minimumComparisons ?? CALIBRATION_MINIMUM_COMPARISONS;
  const comparisonCount = input.comparisons.length;
  const belowFloor = comparisonCount < minimumComparisons;

  // --- clip progress -------------------------------------------------------
  const setsByClip = new Map<string, AnnotationSetRow[]>();
  for (const set of input.sets) {
    const list = setsByClip.get(set.calibration_clip_id) ?? [];
    list.push(set);
    setsByClip.set(set.calibration_clip_id, list);
  }
  const adjudicatedClips = new Set(
    input.adjudications.map((adjudicationRow) => adjudicationRow.calibration_clip_id),
  );

  const clipProgress: ClipProgress = {
    totalClips: input.clips.length,
    clipsNotStarted: 0,
    clipsAwaitingSecondAnnotator: 0,
    clipsAwaitingSecondSubmission: 0,
    clipsReadyToCompare: 0,
    clipsWithAdjudication: 0,
  };

  for (const clip of input.clips) {
    const clipSets = setsByClip.get(clip.calibration_clip_id) ?? [];
    const submitted = clipSets.filter((set) => set.status === 'submitted').length;

    if (clipSets.length === 0) {
      clipProgress.clipsNotStarted += 1;
    } else if (clipSets.length === 1) {
      // A second annotator has not opened a set at all. Distinct from having
      // opened one and not finished: one is a scheduling problem, the other
      // is a work-in-progress, and an operator does different things about
      // them.
      clipProgress.clipsAwaitingSecondAnnotator += 1;
    } else if (submitted < 2) {
      clipProgress.clipsAwaitingSecondSubmission += 1;
    } else {
      clipProgress.clipsReadyToCompare += 1;
    }

    if (adjudicatedClips.has(clip.calibration_clip_id)) {
      clipProgress.clipsWithAdjudication += 1;
    }
  }

  // --- disagreements, and the strata -------------------------------------
  const samplingReasonByClip = new Map(
    input.clips.map((clip) => [clip.calibration_clip_id, clip.primary_sampling_reason]),
  );

  const disagreementCounts = emptyCounts();
  const bySamplingReason: Record<string, Record<DisagreementCategory, number>> = {};
  const byVisibility: Record<string, Record<DisagreementCategory, number>> = {};
  const byEventClass: Record<string, Record<DisagreementCategory, number>> = {};

  const startDeltas: number[] = [];
  const contactDeltas: number[] = [];
  const endDeltas: number[] = [];

  let matchedPairCount = 0;
  let totalComparedEvents = 0;
  let pairingsRaisingDisagreement = 0;

  for (const comparison of input.comparisons) {
    const samplingReason =
      samplingReasonByClip.get(comparison.calibrationClipId) ?? 'unrecorded_sampling_reason';

    for (const pairing of comparison.pairings) {
      totalComparedEvents += 1;
      if (pairing.outcome === 'MATCHED') matchedPairCount += 1;
      if (pairing.disagreements.length > 0) pairingsRaisingDisagreement += 1;

      // Stratify by what the pairing is ABOUT. Where the two readings differ
      // on visibility, both are recorded -- the disagreement belongs to both
      // conditions, and assigning it to only one would understate whichever
      // was dropped.
      const visibilities = new Set(
        [pairing.eventA?.visibility, pairing.eventB?.visibility].filter(
          (value): value is string => typeof value === 'string',
        ),
      );
      const eventClasses = new Set(
        [pairing.eventA?.event_class, pairing.eventB?.event_class].filter(
          (value): value is string => typeof value === 'string',
        ),
      );

      for (const disagreement of pairing.disagreements) {
        disagreementCounts[disagreement.category] += 1;

        bySamplingReason[samplingReason] ??= emptyCounts();
        bySamplingReason[samplingReason][disagreement.category] += 1;

        for (const visibility of visibilities) {
          byVisibility[visibility] ??= emptyCounts();
          byVisibility[visibility][disagreement.category] += 1;
        }
        for (const eventClass of eventClasses) {
          byEventClass[eventClass] ??= emptyCounts();
          byEventClass[eventClass][disagreement.category] += 1;
        }

        if (disagreement.category === 'BOUNDARY' && typeof disagreement.deltaMs === 'number') {
          if (disagreement.field === 'start_ms') startDeltas.push(disagreement.deltaMs);
          if (disagreement.field === 'contact_ms') contactDeltas.push(disagreement.deltaMs);
          if (disagreement.field === 'end_ms') endDeltas.push(disagreement.deltaMs);
        }
      }
    }
  }

  // Field disagreements can only arise on a pair that MATCHED; a missed event
  // by definition did not. Two different denominators, each named.
  const disagreementRates = Object.fromEntries(
    DISAGREEMENT_CATEGORIES.map((category) => {
      const isMissed = category === 'EVENT_MISSED';
      return [
        category,
        makeRate(
          disagreementCounts[category],
          isMissed ? totalComparedEvents : matchedPairCount,
          isMissed ? 'pairings across both readings' : 'matched pairs',
          belowFloor,
        ),
      ];
    }),
  ) as Record<DisagreementCategory, RateWithDenominator>;

  const { unknown, recorded } = countUnknownValues(input.events);

  const hedged = input.events.filter(
    (event) => event.certainty === 'probable' || event.certainty === 'uncertain',
  ).length;

  const unresolvable = input.adjudications.filter(
    (adjudicationRow) => adjudicationRow.resolution_type === 'unresolvable',
  ).length;

  return {
    organizationId: input.organizationId,
    calibrationProjectId: input.calibrationProjectId,
    ontologyVersion: input.ontologyVersion,
    minimumComparisons,
    status: belowFloor ? 'insufficient_data' : 'available',
    comparisonCount,
    clipProgress,
    disagreementCounts,
    disagreementRates,
    boundaryDeltas: {
      start_ms: summariseDeltas(startDeltas),
      contact_ms: summariseDeltas(contactDeltas),
      end_ms: summariseDeltas(endDeltas),
    },
    unknownRate: makeRate(
      unknown,
      recorded,
      'ontology values actually recorded',
      belowFloor,
    ),
    hedgedCertaintyRate: makeRate(
      hedged,
      input.events.length,
      'annotated events',
      belowFloor,
    ),
    adjudicationRate: makeRate(
      input.adjudications.length,
      pairingsRaisingDisagreement,
      'pairings that raised a disagreement',
      belowFloor,
    ),
    unresolvableRate: makeRate(
      unresolvable,
      input.adjudications.length,
      'adjudications recorded',
      belowFloor,
    ),
    strata: {
      bySamplingReason,
      byVisibility,
      byEventClass,
      byStanceMatchup: DENOMINATOR_NOT_CAPTURED,
    },
  };
}

/**
 * One line an operator can read without interpreting a table.
 *
 * Says the sample size in the same breath as anything else, every time, and
 * never states a rate the report itself withheld.
 */
export function describeCalibrationQa(report: CalibrationQaReport): string {
  const { clipProgress } = report;

  if (report.comparisonCount === 0) {
    const waiting =
      clipProgress.clipsAwaitingSecondAnnotator + clipProgress.clipsAwaitingSecondSubmission;
    return waiting > 0
      ? `No clip has two submitted readings yet (${waiting} of ${clipProgress.totalClips} part-way).`
        + ' Nothing can be said about agreement until a second annotator finishes one.'
      : `No annotation has been submitted for any of the ${clipProgress.totalClips} clip(s) in this study.`;
  }

  if (report.status === 'insufficient_data') {
    return `Only ${report.comparisonCount} clip(s) have two submitted readings, below the `
      + `${report.minimumComparisons} needed to report a rate. Counts are shown; every rate is `
      + 'withheld rather than computed from a sample this thin.';
  }

  const missed = report.disagreementRates.EVENT_MISSED;
  return `${report.comparisonCount} clip(s) compared. One annotator recorded an event the other `
    + `did not ${missed.count} time(s) across ${missed.denominator} ${missed.denominatorKind}. `
    + 'Every figure here describes the annotation process, not any athlete and not any annotator.';
}
