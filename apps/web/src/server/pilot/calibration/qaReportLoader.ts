import { listAdjudicationsForClip, type AdjudicationRow } from './adjudication';
import {
  listAnnotationEvents,
  listAnnotationSetsForClip,
  type AnnotationEventRow,
  type AnnotationSetRow,
} from './annotations';
import {
  ComparisonNotEligibleError,
  compareAnnotationSets,
  type AnnotationSetComparison,
} from './comparison';
import { getCalibrationProject, listCalibrationClips } from './projects';
import {
  buildCalibrationQaReport,
  currentAdjudications,
  describeCalibrationQa,
  type CalibrationQaReport,
} from './qaReadModel';

// THE QA READ-OUT'S LOADER. The one place the unblinded readers are used to
// build the agreement report for a whole study.
//
// WHY IT DOES NOT LOAD THROUGH blinding.ts. The adjudication loaders there
// refuse a coach, refuse an administrator who labelled the clip
// (OD-2026-08-29-002) and throw while any set on a clip is unfinished. Those
// are the right refusals for a surface that hands back two RAW readings. This
// one hands back none: annotations.ts names listAnnotationSetsForClip as "the
// adjudicator's and the QA read-out's view", and this is that read-out.
//
// THE BOUNDARY THAT MAKES THAT SAFE, and that every change here must keep:
//
//   * AGGREGATES ONLY LEAVE THIS MODULE. No set id, event id, account id or
//     raw reading is in the result. The rows are read, reduced and dropped.
//   * EVENTS ARE READ ONLY FOR A PAIR ALREADY PROVEN COMPARABLE. Never for an
//     unfinished set, and never for a submitted set whose clip is not compared:
//     a rate over those would describe one labeller's work before the other
//     has finished, which is the leak blinding exists to prevent.
//   * NO AUTO-PAIRING (OD-2026-08-29-003). Two readings pair themselves. Three
//     or more are compared only on a pair a person demonstrably chose from all
//     of them; anything else is left out and counted, not guessed.

/** Clips left out of the comparison, by reason. Counted so the screen can say
 * what the figures do not cover rather than leaving a silent gap. */
export interface QaExcludedClips {
  /** Two or more submitted readings and at least one still in progress. */
  readingInProgress: number;
  /** Three or more submitted readings and no adjudication names a pair. Not
   *  "nobody chose": choosing a pair is only recorded once something is
   *  adjudicated, so this cannot tell the two apart and does not pretend to. */
  noRecordedPair: number;
  /** Three or more submitted readings where the recorded choice is not usable:
   *  more than one pair is named, or a reading was submitted after it. */
  pairNotEstablished: number;
  /** The pair exists and comparison.ts refuses it (two ontology versions, or
   *  one person holding both readings). */
  notComparable: number;
}

export interface CalibrationQaReportResult {
  projectName: string;
  report: CalibrationQaReport;
  summary: string;
  excludedClips: QaExcludedClips;
}

function isSubmitted(set: AnnotationSetRow): boolean {
  return set.status === 'submitted';
}

/** A timestamptz arrives as a Date whatever the row interface says (see
 * AnnotationSetRow.created_at), so both shapes are accepted. */
function toMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

type PairChoice =
  | { outcome: 'pair'; a: AnnotationSetRow; b: AnnotationSetRow }
  | { outcome: 'excluded'; reason: keyof QaExcludedClips };

/**
 * WHICH TWO READINGS OF THIS CLIP ARE COMPARED, IF ANY.
 *
 * For three or more readings the only record of a person's choice is an
 * adjudication row, which names the pair it settled. That is evidence of a
 * choice among ALL the readings only if it was made after the last of them was
 * submitted; a pair adjudicated when the clip had two readings was never
 * chosen over the third.
 */
function choosePair(
  sets: readonly AnnotationSetRow[],
  current: readonly AdjudicationRow[],
): PairChoice | null {
  const submitted = sets.filter(isSubmitted);
  if (submitted.length < 2) return null;
  if (submitted.length < sets.length) return { outcome: 'excluded', reason: 'readingInProgress' };
  if (sets.length === 2) return { outcome: 'pair', a: sets[0], b: sets[1] };

  const named = new Map<string, AdjudicationRow[]>();
  for (const row of current) {
    const key = JSON.stringify([row.annotation_set_id_a, row.annotation_set_id_b].sort());
    named.set(key, [...(named.get(key) ?? []), row]);
  }
  if (named.size === 0) return { outcome: 'excluded', reason: 'noRecordedPair' };
  if (named.size > 1) return { outcome: 'excluded', reason: 'pairNotEstablished' };

  const [rows] = [...named.values()];
  // Canonical order from the clip's own list, as resolveComparisonPair does.
  const pair = sets.filter(
    (set) =>
      set.annotation_set_id === rows[0].annotation_set_id_a
      || set.annotation_set_id === rows[0].annotation_set_id_b,
  );
  const lastSubmission = Math.max(...sets.map((set) => toMs(set.submitted_at)));
  const lastChoice = Math.max(...rows.map((row) => toMs(row.adjudicated_at)));
  if (pair.length !== 2 || !(lastChoice > lastSubmission)) {
    return { outcome: 'excluded', reason: 'pairNotEstablished' };
  }
  return { outcome: 'pair', a: pair[0], b: pair[1] };
}

/**
 * The agreement report for one study, or null when the organization has no
 * such study.
 *
 * Recomputed on every call; nothing is stored. The caller decides who may ask.
 */
export async function loadCalibrationQaReport(
  organizationId: string,
  calibrationProjectId: string,
): Promise<CalibrationQaReportResult | null> {
  const project = await getCalibrationProject(organizationId, calibrationProjectId);
  if (!project) return null;

  const clips = await listCalibrationClips(organizationId, calibrationProjectId);

  const sets: AnnotationSetRow[] = [];
  const events: AnnotationEventRow[] = [];
  const comparisons: AnnotationSetComparison[] = [];
  const adjudications: AdjudicationRow[] = [];
  const excludedClips: QaExcludedClips = {
    readingInProgress: 0,
    noRecordedPair: 0,
    pairNotEstablished: 0,
    notComparable: 0,
  };

  for (const clip of clips) {
    const clipSets = await listAnnotationSetsForClip(organizationId, clip.calibration_clip_id);
    // Every set, in any state: clip progress is counted from these and reads
    // nothing but their status.
    sets.push(...clipSets);

    if (clipSets.filter(isSubmitted).length < 2) continue;

    const clipAdjudications = await listAdjudicationsForClip(
      organizationId,
      clip.calibration_clip_id,
    );
    const choice = choosePair(clipSets, currentAdjudications(clipAdjudications));
    if (!choice) continue;
    if (choice.outcome === 'excluded') {
      excludedClips[choice.reason] += 1;
      continue;
    }

    const eventsA = await listAnnotationEvents(organizationId, choice.a.annotation_set_id);
    const eventsB = await listAnnotationEvents(organizationId, choice.b.annotation_set_id);
    try {
      comparisons.push(compareAnnotationSets(choice.a, eventsA, choice.b, eventsB));
    } catch (error) {
      if (!(error instanceof ComparisonNotEligibleError)) throw error;
      excludedClips.notComparable += 1;
      continue;
    }

    // Only now, and only for the compared pair. An adjudication of a clip that
    // is not compared has no pairing in the denominator it would be counted
    // against, so it is left out with the clip.
    events.push(...eventsA, ...eventsB);
    adjudications.push(
      ...clipAdjudications.filter(
        (row) =>
          [choice.a.annotation_set_id, choice.b.annotation_set_id].includes(row.annotation_set_id_a)
          && [choice.a.annotation_set_id, choice.b.annotation_set_id].includes(row.annotation_set_id_b),
      ),
    );
  }

  const report = buildCalibrationQaReport({
    organizationId,
    calibrationProjectId,
    ontologyVersion: project.ontology_version,
    clips,
    sets,
    events,
    comparisons,
    adjudications,
  });

  return {
    projectName: project.name,
    report,
    summary: describeCalibrationQa(report),
    excludedClips,
  };
}
