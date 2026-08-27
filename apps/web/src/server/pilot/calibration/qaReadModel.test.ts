// Guards on the calibration QA read-out.
//
// Two kinds of thing are being held here. The first is arithmetic: that every
// rate names the denominator it used, that different questions get different
// denominators, and that nothing is computed from a sample too thin to
// describe. The second is refusal: that the report cannot become a leaderboard
// or a statement about an athlete, however easy the underlying data would make
// either.

import type { AdjudicationRow } from './adjudication';
import type { AnnotationEventRow, AnnotationSetRow } from './annotations';
import { compareAnnotationSets } from './comparison';
import {
  CALIBRATION_MINIMUM_COMPARISONS,
  DENOMINATOR_NOT_CAPTURED,
  buildCalibrationQaReport,
  describeCalibrationQa,
} from './qaReadModel';

const ORG = 'org-qa';
const PROJECT = 'project-qa';
const ONTOLOGY = 'boxing-ontology-0.1';
const ANNOTATOR_A = 'acct-annotator-alice';
const ANNOTATOR_B = 'acct-annotator-bob';

function makeSet(clipId: string, suffix: 'a' | 'b'): AnnotationSetRow {
  return {
    organization_id: ORG,
    annotation_set_id: `${clipId}-set-${suffix}`,
    calibration_clip_id: clipId,
    annotator_account_id: suffix === 'a' ? ANNOTATOR_A : ANNOTATOR_B,
    ontology_version: ONTOLOGY,
    status: 'submitted',
    created_at: '2026-08-27T00:00:00.000Z',
    submitted_at: '2026-08-27T01:00:00.000Z',
  };
}

function makeEvent(
  clipId: string,
  suffix: 'a' | 'b',
  overrides: Partial<AnnotationEventRow> = {},
): AnnotationEventRow {
  return {
    organization_id: ORG,
    event_id: `${clipId}-evt-${suffix}`,
    annotation_set_id: `${clipId}-set-${suffix}`,
    calibration_clip_id: clipId,
    clip_start_ms: 0,
    clip_end_ms: 20_000,
    event_class: 'punch',
    actor_track: 'red',
    opponent_track: 'blue',
    start_ms: 1_000,
    end_ms: 1_400,
    contact_ms: null,
    peak_ms: null,
    physical_hand: 'left',
    hand_role: 'lead',
    stance: 'orthodox',
    punch_type: 'lead_straight',
    target_zone: 'head',
    contact_result: 'clean_target_contact',
    contact_zone: 'head',
    defense_type: null,
    visibility: 'clear',
    certainty: 'clear',
    combination_group: null,
    sequence_order: null,
    counter_against_event_id: null,
    defends_against_event_id: null,
    created_at: '2026-08-27T00:30:00.000Z',
    ...overrides,
  };
}

/** One clip where the two readings differ exactly as described. */
function stagedClip(
  clipId: string,
  samplingReason: string,
  aOverrides: Partial<AnnotationEventRow> = {},
  bOverrides: Partial<AnnotationEventRow> = {},
) {
  const eventA = makeEvent(clipId, 'a', aOverrides);
  const eventB = makeEvent(clipId, 'b', bOverrides);
  return {
    clip: { calibration_clip_id: clipId, primary_sampling_reason: samplingReason },
    sets: [makeSet(clipId, 'a'), makeSet(clipId, 'b')],
    events: [eventA, eventB],
    comparison: compareAnnotationSets(makeSet(clipId, 'a'), [eventA], makeSet(clipId, 'b'), [eventB]),
  };
}

/** Enough clips to clear the sample floor, all in perfect agreement unless
 * the caller stages otherwise. */
function studyOf(staged: ReturnType<typeof stagedClip>[]) {
  return buildCalibrationQaReport({
    organizationId: ORG,
    calibrationProjectId: PROJECT,
    ontologyVersion: ONTOLOGY,
    clips: staged.map((entry) => entry.clip),
    sets: staged.flatMap((entry) => entry.sets),
    events: staged.flatMap((entry) => entry.events),
    comparisons: staged.map((entry) => entry.comparison),
    adjudications: [],
  });
}

function fullStudy(overrides: Partial<Parameters<typeof stagedClip>> = []) {
  return Array.from({ length: CALIBRATION_MINIMUM_COMPARISONS }, (_unused, index) =>
    stagedClip(`clip-${index}`, 'isolated_punch', ...(overrides as [])),
  );
}

describe('the report can never become a leaderboard or a statement about an athlete', () => {
  test('no annotator account id appears anywhere in the serialized report', () => {
    // THE GUARD THIS FILE EXISTS FOR. The inputs carry both annotators'
    // account ids and the data would trivially support a per-annotator
    // breakdown. An annotator leaderboard would turn a measurement exercise
    // into a performance review, and coaches would start labelling to agree
    // with each other rather than to record what they saw -- destroying the
    // exact signal the study collects.
    const report = studyOf(fullStudy());
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(ANNOTATOR_A);
    expect(serialized).not.toContain(ANNOTATOR_B);
    expect(serialized.toLowerCase()).not.toContain('annotator_account');
  });

  test('the report carries no score, confidence, ranking, or athlete', () => {
    const report = studyOf(fullStudy());
    const serialized = JSON.stringify(report).toLowerCase();

    for (const forbidden of [
      'athlete',
      'leaderboard',
      'ranking',
      'ontologyconfidence',
      'overallscore',
      'accuracy',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('the one-line summary says what it is measuring, and what it is not', () => {
    const report = studyOf(fullStudy());
    const line = describeCalibrationQa(report);
    expect(line).toMatch(/not any athlete and not any annotator/);
  });
});

describe('rates are withheld below the sample floor', () => {
  test('counts are reported and every rate is null', () => {
    const thin = studyOf([
      stagedClip('clip-thin-1', 'isolated_punch', {}, { punch_type: 'rear_hook' }),
      stagedClip('clip-thin-2', 'isolated_punch', {}, { punch_type: 'rear_hook' }),
    ]);

    expect(thin.status).toBe('insufficient_data');
    // The COUNT is still shown -- a caller must be able to see how thin the
    // sample is, not just be told nothing.
    expect(thin.disagreementCounts.PUNCH_TYPE).toBe(2);
    expect(thin.disagreementRates.PUNCH_TYPE.rate).toBeNull();
    expect(thin.disagreementRates.PUNCH_TYPE.count).toBe(2);
    expect(thin.unknownRate.rate).toBeNull();
    expect(thin.adjudicationRate.rate).toBeNull();
  });

  test('the summary refuses to state a rate it withheld', () => {
    const thin = studyOf([stagedClip('clip-one', 'isolated_punch')]);
    const line = describeCalibrationQa(thin);
    expect(line).toMatch(/below the 5 needed/);
    expect(line).toMatch(/withheld rather than computed/);
  });

  test('an empty study says so rather than reporting zeroes as agreement', () => {
    const empty = buildCalibrationQaReport({
      organizationId: ORG,
      calibrationProjectId: PROJECT,
      ontologyVersion: ONTOLOGY,
      clips: [{ calibration_clip_id: 'clip-x', primary_sampling_reason: 'defense' }],
      sets: [],
      events: [],
      comparisons: [],
      adjudications: [],
    });
    expect(describeCalibrationQa(empty)).toMatch(/No annotation has been submitted/);
  });

  test('above the floor, rates appear', () => {
    const report = studyOf(fullStudy());
    expect(report.status).toBe('available');
    expect(report.disagreementRates.PUNCH_TYPE.rate).not.toBeNull();
  });
});

describe('every rate names its denominator, and they are not the same one', () => {
  test('a missed event and a field disagreement are counted against different things', () => {
    // A field disagreement can only arise on a pair that MATCHED. A missed
    // event by definition did not. Dividing both by one number would be
    // arithmetic that reads as a finding.
    const staged = [
      ...Array.from({ length: 4 }, (_unused, index) =>
        stagedClip(`clip-m-${index}`, 'isolated_punch', {}, { punch_type: 'rear_hook' }),
      ),
      // One clip where the readings do not overlap at all -> two missed events.
      stagedClip('clip-miss', 'occlusion', { start_ms: 1_000, end_ms: 1_400 }, { start_ms: 8_000, end_ms: 8_400 }),
    ];
    const report = studyOf(staged);

    expect(report.disagreementRates.EVENT_MISSED.denominatorKind).toBe(
      'pairings across both readings',
    );
    expect(report.disagreementRates.PUNCH_TYPE.denominatorKind).toBe('matched pairs');
    expect(report.disagreementRates.EVENT_MISSED.denominator).not.toBe(
      report.disagreementRates.PUNCH_TYPE.denominator,
    );
    expect(report.disagreementCounts.EVENT_MISSED).toBe(2);
    expect(report.disagreementCounts.PUNCH_TYPE).toBe(4);
  });

  test('the unknown rate counts only recorded values, and never counts a miss as unknown', () => {
    // contact_zone carries BOTH 'unknown' and 'none'. 'none' is an OBSERVED
    // miss; counting it as unknown would turn clean observations into
    // evidence the footage was unreadable. A null is "not recorded" and
    // belongs in neither the numerator nor the denominator.
    const clip = { calibration_clip_id: 'clip-u', primary_sampling_reason: 'other' };
    const events = [
      makeEvent('clip-u', 'a', { contact_zone: 'unknown', stance: 'unknown' }),
      makeEvent('clip-u', 'b', { contact_zone: 'none', stance: null }),
    ];
    const report = buildCalibrationQaReport({
      organizationId: ORG,
      calibrationProjectId: PROJECT,
      ontologyVersion: ONTOLOGY,
      clips: [clip],
      sets: [makeSet('clip-u', 'a'), makeSet('clip-u', 'b')],
      events,
      comparisons: [],
      adjudications: [],
      minimumComparisons: 0,
    });

    // Event A: 5 recorded fields, 2 unknown. Event B: 4 recorded (stance is
    // null), 0 unknown -- 'none' is not unknown.
    expect(report.unknownRate.count).toBe(2);
    expect(report.unknownRate.denominator).toBe(9);
    expect(report.unknownRate.denominatorKind).toBe('ontology values actually recorded');
  });

  test('the unresolvable rate is counted against adjudications, not against clips', () => {
    const staged = fullStudy();
    const adjudications: AdjudicationRow[] = [
      {
        organization_id: ORG,
        adjudication_id: 'adj-1',
        calibration_clip_id: 'clip-0',
        annotation_set_id_a: 'clip-0-set-a',
        annotation_set_id_b: 'clip-0-set-b',
        source_event_id_a: 'clip-0-evt-a',
        source_event_id_b: 'clip-0-evt-b',
        resolution_type: 'unresolvable',
        missed_event_verdict: null,
        adjudicator_account_id: 'acct-reviewer',
        adjudicated_at: '2026-08-27T02:00:00.000Z',
        ontology_version: ONTOLOGY,
        notes: null,
        created_at: '2026-08-27T02:00:00.000Z',
      },
    ];

    const report = buildCalibrationQaReport({
      organizationId: ORG,
      calibrationProjectId: PROJECT,
      ontologyVersion: ONTOLOGY,
      clips: staged.map((entry) => entry.clip),
      sets: staged.flatMap((entry) => entry.sets),
      events: staged.flatMap((entry) => entry.events),
      comparisons: staged.map((entry) => entry.comparison),
      adjudications,
    });

    expect(report.unresolvableRate.count).toBe(1);
    expect(report.unresolvableRate.denominator).toBe(1);
    expect(report.unresolvableRate.denominatorKind).toBe('adjudications recorded');
    expect(report.clipProgress.clipsWithAdjudication).toBe(1);
  });
});

describe('boundary deltas', () => {
  // A LONG shared event, with only B's start moved. Deliberate: under the
  // zero-tolerance matching rule two spans must genuinely overlap to be
  // paired at all, so a short event caps how large a boundary delta can ever
  // be observed -- past that, the pair stops matching and the disagreement is
  // reported as EVENT_MISSED instead. That is a real property of the matching
  // policy, and a fixture built on short events silently cannot produce the
  // large deltas these tests are about.
  function studyWithOffsets(offsets: number[]) {
    const staged = offsets.map((offset, index) =>
      stagedClip(
        `clip-d-${index}`,
        'isolated_punch',
        { start_ms: 1_000, end_ms: 19_000 },
        { start_ms: 1_000 - offset, end_ms: 19_000 },
      ),
    );
    return studyOf(staged);
  }

  test('a systematic offset and symmetric noise are distinguishable', () => {
    // The delta is (A - B), so an offset of 40 means A read the boundary 40ms
    // later than B did.
    //
    // Both studies below have a median ABSOLUTE delta of 40 -- the annotators
    // were the same distance apart in each. Only the SIGNED median tells them
    // apart: one annotator consistently later, versus the two scattering
    // either side. Reporting only the absolute figure would hide a systematic
    // offset; reporting only the signed one would make scatter look like
    // agreement. That is why both exist.
    const systematic = studyWithOffsets([40, 40, 40, 40, 40]);
    expect(systematic.boundaryDeltas.start_ms.medianMs).toBe(40);
    expect(systematic.boundaryDeltas.start_ms.medianAbsoluteMs).toBe(40);
    expect(systematic.boundaryDeltas.start_ms.minMs).toBe(40);
    expect(systematic.boundaryDeltas.start_ms.maxMs).toBe(40);

    const scattered = studyWithOffsets([-40, -40, -10, 40, 40]);
    expect(scattered.boundaryDeltas.start_ms.medianAbsoluteMs).toBe(40);
    // Signed median collapses toward zero; absolute median does not.
    expect(Math.abs(scattered.boundaryDeltas.start_ms.medianMs as number)).toBeLessThan(
      scattered.boundaryDeltas.start_ms.medianAbsoluteMs as number,
    );
    expect(scattered.boundaryDeltas.start_ms.minMs).toBe(-40);
    expect(scattered.boundaryDeltas.start_ms.maxMs).toBe(40);
  });

  test('one mis-clicked boundary does not describe the whole study', () => {
    // A mean would be dragged past -3000 by the outlier and would describe a
    // study in which nobody annotated anything like that. The median is a
    // delta somebody actually produced.
    const report = studyWithOffsets([-10, -10, -10, -10, -15_000]);
    expect(report.boundaryDeltas.start_ms.medianMs).toBe(-10);
    expect(report.boundaryDeltas.start_ms.medianAbsoluteMs).toBe(10);
    // The outlier is still visible -- summarised, never discarded.
    expect(report.boundaryDeltas.start_ms.minMs).toBe(-15_000);
    expect(report.boundaryDeltas.start_ms.count).toBe(5);
  });

  test('no buckets are invented', () => {
    const report = studyWithOffsets([-10, -20, -30, -40, -50]);
    const serialized = JSON.stringify(report.boundaryDeltas);
    for (const bucketish of ['bucket', 'band', 'within', 'range_', 'histogram']) {
      expect(serialized.toLowerCase()).not.toContain(bucketish);
    }
  });

  test('a boundary nobody produced summarises as empty rather than zero', () => {
    const report = studyOf(fullStudy());
    // No contact_ms was recorded anywhere, so there is no distribution --
    // reported as absent, never as a delta of 0, which would read as perfect
    // agreement about a timestamp neither annotator gave.
    expect(report.boundaryDeltas.contact_ms.count).toBe(0);
    expect(report.boundaryDeltas.contact_ms.medianMs).toBeNull();
  });
});

describe('clip progress distinguishes states an operator acts on differently', () => {
  test('not started, awaiting a second annotator, and awaiting a second submission are separate', () => {
    const started = makeSet('clip-solo', 'a');
    const partial = [makeSet('clip-partial', 'a'), { ...makeSet('clip-partial', 'b'), status: 'in_progress', submitted_at: null }];
    const done = stagedClip('clip-done', 'combination');

    const report = buildCalibrationQaReport({
      organizationId: ORG,
      calibrationProjectId: PROJECT,
      ontologyVersion: ONTOLOGY,
      clips: [
        { calibration_clip_id: 'clip-empty', primary_sampling_reason: 'other' },
        { calibration_clip_id: 'clip-solo', primary_sampling_reason: 'other' },
        { calibration_clip_id: 'clip-partial', primary_sampling_reason: 'other' },
        done.clip,
      ],
      sets: [started, ...partial, ...done.sets],
      events: done.events,
      comparisons: [done.comparison],
      adjudications: [],
    });

    expect(report.clipProgress.totalClips).toBe(4);
    expect(report.clipProgress.clipsNotStarted).toBe(1);
    // Nobody has opened a second set: a scheduling problem.
    expect(report.clipProgress.clipsAwaitingSecondAnnotator).toBe(1);
    // Someone opened one and has not finished: a work-in-progress.
    expect(report.clipProgress.clipsAwaitingSecondSubmission).toBe(1);
    expect(report.clipProgress.clipsReadyToCompare).toBe(1);
  });
});

describe('stratification', () => {
  test('disagreements are grouped by the stratum the clip was sampled for', () => {
    const report = studyOf([
      ...Array.from({ length: 3 }, (_unused, index) =>
        stagedClip(`clip-iso-${index}`, 'isolated_punch', {}, { punch_type: 'rear_hook' }),
      ),
      ...Array.from({ length: 2 }, (_unused, index) =>
        stagedClip(`clip-occ-${index}`, 'occlusion', {}, { punch_type: 'rear_hook' }),
      ),
    ]);

    expect(report.strata.bySamplingReason.isolated_punch.PUNCH_TYPE).toBe(3);
    expect(report.strata.bySamplingReason.occlusion.PUNCH_TYPE).toBe(2);
  });

  test('a disagreement about visibility is counted under BOTH readings of it', () => {
    // Assigning it to only one condition would understate whichever was
    // dropped -- and which one gets dropped would be an arbitrary choice this
    // module has no basis for making.
    const report = studyOf([
      ...fullStudy(),
      stagedClip('clip-vis', 'occlusion', { visibility: 'clear' }, { visibility: 'partially_occluded' }),
    ]);

    expect(report.strata.byVisibility.clear.VISIBILITY).toBeGreaterThan(0);
    expect(report.strata.byVisibility.partially_occluded.VISIBILITY).toBeGreaterThan(0);
  });

  test('stance matchup is reported as not capturable, not computed from a biased subset', () => {
    // An event records only the ACTOR's stance. The opponent's lives on the
    // opponent's own event, which the other annotator may never have made --
    // so the subset where both exist is not a random sample of exchanges, it
    // is the exchanges busy enough for both fighters to have been annotated.
    const report = studyOf(fullStudy());
    expect(report.strata.byStanceMatchup).toBe(DENOMINATOR_NOT_CAPTURED);
    expect(report.strata.byStanceMatchup).toBe('UNAVAILABLE — DENOMINATOR_NOT_CAPTURED');
  });
});

describe('determinism', () => {
  test('the same study produces a byte-identical report', () => {
    const staged = fullStudy();
    const first = studyOf(staged);
    const second = studyOf(staged);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
