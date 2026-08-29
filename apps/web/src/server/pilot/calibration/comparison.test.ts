// Guards on the disagreement read model.
//
// No database: compareAnnotationSets is pure over rows, and the rows it reads
// are already covered by calibrationAnnotations.pg.test.ts. What needs proving
// here is the judgement -- which pairings are refused, which are called
// ambiguous rather than forced, and which differences are counted as what.

import type { AnnotationEventRow, AnnotationSetRow } from './annotations';
import {
  ComparisonNotEligibleError,
  DISAGREEMENT_CATEGORIES,
  PILOT_MATCHING_POLICY_V0_UNCALIBRATED,
  compareAnnotationSets,
  countDisagreementsByCategory,
  resolveComparisonPair,
  type AnnotationSetComparison,
  type DisagreementCategory,
} from './comparison';
import * as comparisonModule from './comparison';

const ORG = 'org-cmp';
const CLIP = 'clip-cmp';

function makeSet(overrides: Partial<AnnotationSetRow> = {}): AnnotationSetRow {
  return {
    organization_id: ORG,
    annotation_set_id: 'set-a',
    calibration_clip_id: CLIP,
    annotator_account_id: 'acct-a',
    ontology_version: 'boxing-ontology-0.1',
    status: 'submitted',
    created_at: '2026-08-27T00:00:00.000Z',
    submitted_at: '2026-08-27T01:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AnnotationEventRow> = {}): AnnotationEventRow {
  return {
    organization_id: ORG,
    event_id: 'evt-1',
    annotation_set_id: 'set-a',
    calibration_clip_id: CLIP,
    clip_start_ms: 0,
    clip_end_ms: 12_000,
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

const SET_A = makeSet();
const SET_B = makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-b' });

function inB(overrides: Partial<AnnotationEventRow> = {}): AnnotationEventRow {
  return makeEvent({ annotation_set_id: 'set-b', event_id: 'evt-b1', ...overrides });
}

function categoriesOf(comparison: AnnotationSetComparison): DisagreementCategory[] {
  return comparison.pairings.flatMap((pairing) =>
    pairing.disagreements.map((disagreement) => disagreement.category),
  );
}

describe('pairing two readings of the same clip', () => {
  test('two identical readings match with nothing to report', () => {
    const result = compareAnnotationSets(SET_A, [makeEvent()], SET_B, [inB()]);

    expect(result.pairings).toHaveLength(1);
    expect(result.pairings[0].outcome).toBe('MATCHED');
    expect(result.pairings[0].disagreements).toEqual([]);
  });

  test('events that do not overlap are each reported as missed by the other', () => {
    const result = compareAnnotationSets(
      SET_A,
      [makeEvent({ start_ms: 1_000, end_ms: 1_400 })],
      SET_B,
      [inB({ start_ms: 5_000, end_ms: 5_400 })],
    );

    expect(result.pairings.map((pairing) => pairing.outcome).sort()).toEqual([
      'ONLY_IN_A',
      'ONLY_IN_B',
    ]);
    expect(categoriesOf(result)).toEqual(['EVENT_MISSED', 'EVENT_MISSED']);
  });

  test('a different actor or a different class is never a candidate', () => {
    const differentActor = compareAnnotationSets(SET_A, [makeEvent()], SET_B, [
      inB({ actor_track: 'blue' }),
    ]);
    expect(differentActor.pairings.every((pairing) => pairing.outcome !== 'MATCHED')).toBe(true);

    const differentClass = compareAnnotationSets(SET_A, [makeEvent()], SET_B, [
      inB({
        event_class: 'defense',
        defense_type: 'slip',
        punch_type: null,
        target_zone: null,
        contact_result: null,
        contact_zone: null,
      }),
    ]);
    expect(differentClass.pairings.every((pairing) => pairing.outcome !== 'MATCHED')).toBe(true);
  });

  test('one long exchange against three punches is AMBIGUOUS, never forced', () => {
    // The case that makes forcing a pairing dishonest: annotator B marked one
    // span covering all three of A's punches. There is no correspondence
    // either of them asserted, and inventing one would then get counted as
    // agreement or disagreement about a field, neither of which happened.
    const result = compareAnnotationSets(
      SET_A,
      [
        makeEvent({ event_id: 'a1', start_ms: 1_000, end_ms: 1_300 }),
        makeEvent({ event_id: 'a2', start_ms: 1_400, end_ms: 1_700 }),
        makeEvent({ event_id: 'a3', start_ms: 1_800, end_ms: 2_100 }),
      ],
      SET_B,
      [inB({ event_id: 'b1', start_ms: 900, end_ms: 2_200 })],
    );

    expect(result.pairings).toHaveLength(4);
    expect(result.pairings.every((pairing) => pairing.outcome === 'MATCH_AMBIGUOUS')).toBe(true);
    // No disagreement is manufactured out of an ambiguity.
    expect(categoriesOf(result)).toEqual([]);
    // The evidence for refusing to pair is reported.
    const wide = result.pairings.find((pairing) => pairing.eventB?.event_id === 'b1');
    expect(wide?.candidateCount).toBe(3);
  });

  test('the ambiguity is symmetric -- one long reading of A against two of B is also refused', () => {
    // The MIRROR of the case above, and it is not redundant. When B holds the
    // long span, A's events each have one candidate and are blocked by the
    // B-side check. When A holds it, A's event has two candidates and each of
    // B's has exactly one -- so a check that only refuses on the count it
    // happens to be looking at will force A's single event onto whichever of
    // B's it sees first, and then report field disagreements against a
    // correspondence neither annotator made. Mutation-testing found this gap:
    // the one-directional version of this suite passed that bug.
    const result = compareAnnotationSets(
      SET_A,
      [makeEvent({ event_id: 'a1', start_ms: 1_000, end_ms: 2_000 })],
      SET_B,
      [
        inB({ event_id: 'b1', start_ms: 1_100, end_ms: 1_300 }),
        inB({ event_id: 'b2', start_ms: 1_400, end_ms: 1_600 }),
      ],
    );

    expect(result.pairings).toHaveLength(3);
    expect(result.pairings.every((pairing) => pairing.outcome === 'MATCH_AMBIGUOUS')).toBe(true);
    expect(categoriesOf(result)).toEqual([]);

    const wide = result.pairings.find((pairing) => pairing.eventA?.event_id === 'a1');
    expect(wide?.candidateCount).toBe(2);
  });

  test('a pairing must be one-to-one from BOTH sides', () => {
    // A's single event overlaps only b1, so from A's side it looks
    // unambiguous. But b1 also overlaps A's second event, so pairing them
    // would assert a correspondence A did not make. Checking only one side is
    // the obvious bug this pins.
    const result = compareAnnotationSets(
      SET_A,
      [
        makeEvent({ event_id: 'a1', start_ms: 1_000, end_ms: 1_500 }),
        makeEvent({ event_id: 'a2', start_ms: 1_400, end_ms: 1_900 }),
      ],
      SET_B,
      [inB({ event_id: 'b1', start_ms: 1_200, end_ms: 1_600 })],
    );

    expect(result.pairings.every((pairing) => pairing.outcome === 'MATCH_AMBIGUOUS')).toBe(true);
  });
});

describe('what a matched pair disagrees about', () => {
  test.each([
    ['punch_type', 'rear_hook', 'PUNCH_TYPE'],
    ['physical_hand', 'right', 'PHYSICAL_HAND'],
    ['hand_role', 'rear', 'HAND_ROLE'],
    ['stance', 'southpaw', 'STANCE'],
    ['target_zone', 'torso', 'TARGET'],
    ['contact_result', 'no_contact', 'CONTACT_RESULT'],
    ['contact_zone', 'glove', 'CONTACT_ZONE'],
    ['visibility', 'partially_occluded', 'VISIBILITY'],
    ['certainty', 'uncertain', 'CERTAINTY'],
    ['combination_group', 'exchange-2', 'COMBINATION'],
    ['opponent_track', 'green', 'OTHER'],
  ])('a difference in %s is categorised %s', (field, valueB, expected) => {
    const result = compareAnnotationSets(SET_A, [makeEvent()], SET_B, [
      inB({ [field]: valueB } as Partial<AnnotationEventRow>),
    ]);
    expect(categoriesOf(result)).toEqual([expected]);
  });

  test('a defense type difference is categorised DEFENSE_TYPE', () => {
    const defense = {
      event_class: 'defense' as const,
      punch_type: null,
      target_zone: null,
      contact_result: null,
      contact_zone: null,
      physical_hand: null,
      hand_role: null,
    };
    const result = compareAnnotationSets(
      SET_A,
      [makeEvent({ ...defense, defense_type: 'slip' })],
      SET_B,
      [inB({ ...defense, defense_type: 'parry' })],
    );
    expect(categoriesOf(result)).toEqual(['DEFENSE_TYPE']);
  });

  test('each boundary is reported separately, with a signed delta', () => {
    // A start 40ms early and an end 40ms late is a different observation from
    // both being 40ms early, so the deltas are per boundary and never summed.
    const result = compareAnnotationSets(
      SET_A,
      [makeEvent({ start_ms: 1_000, end_ms: 1_400 })],
      SET_B,
      [inB({ start_ms: 1_040, end_ms: 1_360 })],
    );

    const boundaries = result.pairings[0].disagreements.filter(
      (disagreement) => disagreement.category === 'BOUNDARY',
    );
    expect(boundaries).toHaveLength(2);
    expect(boundaries.find((entry) => entry.field === 'start_ms')?.deltaMs).toBe(-40);
    expect(boundaries.find((entry) => entry.field === 'end_ms')?.deltaMs).toBe(40);
  });

  test('a delta is not invented when only one annotator recorded the boundary', () => {
    const result = compareAnnotationSets(
      SET_A,
      [makeEvent({ contact_ms: 1_200 })],
      SET_B,
      [inB({ contact_ms: null })],
    );

    const contact = result.pairings[0].disagreements.find(
      (disagreement) => disagreement.field === 'contact_ms',
    );
    expect(contact?.category).toBe('BOUNDARY');
    expect(contact?.valueB).toBeNull();
    // Absence is not zero, and it is not a distance either.
    expect(contact?.deltaMs).toBeUndefined();
  });
});

describe('relationships are compared by what they point at, not by id', () => {
  test('two annotators who both marked the same counter AGREE', () => {
    // THE TRAP. Event ids are unique to one annotator's set, so A's
    // counter_against_event_id can never equal B's. A naive raw comparison
    // reports a COUNTER disagreement on every single countered punch -- worse
    // than not comparing, because it looks like a finding.
    const aFirst = makeEvent({ event_id: 'a1', start_ms: 1_000, end_ms: 1_300 });
    const aCounter = makeEvent({
      event_id: 'a2',
      start_ms: 1_400,
      end_ms: 1_700,
      counter_against_event_id: 'a1',
    });
    const bFirst = inB({ event_id: 'b1', start_ms: 1_000, end_ms: 1_300 });
    const bCounter = inB({
      event_id: 'b2',
      start_ms: 1_400,
      end_ms: 1_700,
      counter_against_event_id: 'b1',
    });

    const result = compareAnnotationSets(SET_A, [aFirst, aCounter], SET_B, [bFirst, bCounter]);

    expect(result.pairings.every((pairing) => pairing.outcome === 'MATCHED')).toBe(true);
    expect(categoriesOf(result)).toEqual([]);
  });

  test('one annotator seeing a counter the other did not is a COUNTER disagreement', () => {
    const aFirst = makeEvent({ event_id: 'a1', start_ms: 1_000, end_ms: 1_300 });
    const aCounter = makeEvent({
      event_id: 'a2',
      start_ms: 1_400,
      end_ms: 1_700,
      counter_against_event_id: 'a1',
    });
    const bFirst = inB({ event_id: 'b1', start_ms: 1_000, end_ms: 1_300 });
    const bCounter = inB({ event_id: 'b2', start_ms: 1_400, end_ms: 1_700 });

    const result = compareAnnotationSets(SET_A, [aFirst, aCounter], SET_B, [bFirst, bCounter]);
    expect(categoriesOf(result)).toEqual(['COUNTER']);
  });

  test('counters pointing at DIFFERENT moments disagree', () => {
    const aFirst = makeEvent({ event_id: 'a1', start_ms: 1_000, end_ms: 1_300 });
    const aSecond = makeEvent({ event_id: 'a2', start_ms: 2_000, end_ms: 2_300 });
    const aCounter = makeEvent({
      event_id: 'a3',
      start_ms: 3_000,
      end_ms: 3_300,
      counter_against_event_id: 'a1',
    });
    const bFirst = inB({ event_id: 'b1', start_ms: 1_000, end_ms: 1_300 });
    const bSecond = inB({ event_id: 'b2', start_ms: 2_000, end_ms: 2_300 });
    const bCounter = inB({
      event_id: 'b3',
      start_ms: 3_000,
      end_ms: 3_300,
      counter_against_event_id: 'b2',
    });

    const result = compareAnnotationSets(
      SET_A,
      [aFirst, aSecond, aCounter],
      SET_B,
      [bFirst, bSecond, bCounter],
    );
    expect(categoriesOf(result)).toEqual(['COUNTER']);
  });
});

describe('comparisons that are refused rather than answered', () => {
  test.each([
    ['CROSS_ORGANIZATION', makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-b', organization_id: 'other-org' })],
    ['DIFFERENT_CLIPS', makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-b', calibration_clip_id: 'clip-other' })],
    ['SAME_ANNOTATOR', makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-a' })],
    ['NOT_BOTH_SUBMITTED', makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-b', status: 'in_progress', submitted_at: null })],
    ['ONTOLOGY_VERSION_MISMATCH', makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-b', ontology_version: 'boxing-ontology-0.2' })],
  ])('%s is refused', (reason, setB) => {
    try {
      compareAnnotationSets(SET_A, [makeEvent()], setB, [inB()]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ComparisonNotEligibleError);
      expect((error as ComparisonNotEligibleError).reason).toBe(reason);
    }
  });

  test('a set cannot be compared with itself', () => {
    expect(() => compareAnnotationSets(SET_A, [makeEvent()], SET_A, [makeEvent()])).toThrow(
      ComparisonNotEligibleError,
    );
  });

  test('an in-progress set is refused because it is not yet a reading', () => {
    // Comparing against work in progress would report every event the
    // annotator has not reached yet as one the other "missed".
    expect(() =>
      compareAnnotationSets(
        SET_A,
        [makeEvent()],
        makeSet({ annotation_set_id: 'set-b', annotator_account_id: 'acct-b', status: 'in_progress', submitted_at: null }),
        [inB()],
      ),
    ).toThrow(/both annotation sets must be submitted/);
  });
});

describe('the matching policy is a stated choice, not a hidden constant', () => {
  test('the pilot policy is marked UNCALIBRATED and uses no tolerance', () => {
    expect(PILOT_MATCHING_POLICY_V0_UNCALIBRATED.calibrationState).toBe('UNCALIBRATED');
    expect(PILOT_MATCHING_POLICY_V0_UNCALIBRATED.overlapToleranceMs).toBe(0);
  });

  test('the policy travels inside every comparison', () => {
    const result = compareAnnotationSets(SET_A, [makeEvent()], SET_B, [inB()]);
    expect(result.matchingPolicy.policyVersion).toBe('pilot-temporal-overlap-v0');
    expect(result.matchingPolicy.calibrationState).toBe('UNCALIBRATED');
    expect(result.ontologyVersion).toBe('boxing-ontology-0.1');
  });

  test('no export is named DEFAULT, STANDARD or RECOMMENDED', () => {
    // The same guard patterns/policy.test.ts keeps, for the same reason: a
    // threshold named "default" stops being read as a choice somebody made.
    const exported = Object.keys(comparisonModule);
    expect(exported.some((name) => /DEFAULT|STANDARD|RECOMMENDED/i.test(name))).toBe(false);
  });

  test('a tolerance is honoured when one is supplied, and changes the outcome', () => {
    const near = {
      setA: [makeEvent({ start_ms: 1_000, end_ms: 1_400 })],
      setB: [inB({ start_ms: 1_420, end_ms: 1_800 })],
    };

    const strict = compareAnnotationSets(SET_A, near.setA, SET_B, near.setB);
    expect(strict.pairings.map((pairing) => pairing.outcome).sort()).toEqual([
      'ONLY_IN_A',
      'ONLY_IN_B',
    ]);

    const lenient = compareAnnotationSets(SET_A, near.setA, SET_B, near.setB, {
      ...PILOT_MATCHING_POLICY_V0_UNCALIBRATED,
      policyVersion: 'test-tolerance-50ms',
      overlapToleranceMs: 50,
    });
    expect(lenient.pairings).toHaveLength(1);
    expect(lenient.pairings[0].outcome).toBe('MATCHED');
    // And the output says which rule produced it.
    expect(lenient.matchingPolicy.policyVersion).toBe('test-tolerance-50ms');
  });
});

describe('the result carries no invented aggregate', () => {
  test('there is no score, confidence, or agreement rate anywhere in the result', () => {
    const result = compareAnnotationSets(SET_A, [makeEvent()], SET_B, [inB({ punch_type: 'rear_hook' })]);
    const serialized = JSON.stringify(result);

    for (const forbidden of ['score', 'confidence', 'agreementRate', 'accuracy', 'kappa']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test('counts are per category, with no denominator supplied', () => {
    const result = compareAnnotationSets(
      SET_A,
      [makeEvent({ event_id: 'a1' }), makeEvent({ event_id: 'a2', start_ms: 5_000, end_ms: 5_400 })],
      SET_B,
      [inB({ event_id: 'b1', punch_type: 'rear_hook', visibility: 'partially_occluded' })],
    );

    const counts = countDisagreementsByCategory(result);
    expect(counts.PUNCH_TYPE).toBe(1);
    expect(counts.VISIBILITY).toBe(1);
    expect(counts.EVENT_MISSED).toBe(1);
    // Every category is present as a key, so a zero is a measured zero rather
    // than a missing entry a caller has to guess about.
    expect(Object.keys(counts).sort()).toEqual([...DISAGREEMENT_CATEGORIES].sort());
  });
});

describe('determinism', () => {
  test('the same inputs produce a byte-identical comparison', () => {
    // No clock, no randomness, no I/O -- which is what lets this be recomputed
    // on read instead of stored.
    const events = [
      makeEvent({ event_id: 'a1', start_ms: 2_000, end_ms: 2_400 }),
      makeEvent({ event_id: 'a2', start_ms: 1_000, end_ms: 1_400 }),
    ];
    const others = [inB({ event_id: 'b1', start_ms: 1_000, end_ms: 1_400 })];

    const first = compareAnnotationSets(SET_A, events, SET_B, others);
    const second = compareAnnotationSets(SET_A, events, SET_B, others);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // And pairings come back in timeline order regardless of input order.
    const starts = first.pairings.map(
      (pairing) => pairing.eventA?.start_ms ?? pairing.eventB?.start_ms,
    );
    expect(starts).toEqual([...starts].sort((left, right) => (left ?? 0) - (right ?? 0)));
  });
});

describe('choosing which two readings a clip means', () => {
  const SET_C = makeSet({ annotation_set_id: 'set-c', annotator_account_id: 'acct-c' });
  const three = [SET_A, SET_B, SET_C];

  test('two readings still pair themselves -- there is only one pair to make', () => {
    // Unchanged behaviour, asserted so the new path cannot quietly start
    // demanding a choice on the clips that never needed one.
    expect(resolveComparisonPair([SET_A, SET_B], null, null))
      .toEqual({ outcome: 'pair', a: SET_A, b: SET_B });
  });

  test('three readings and no choice is a question, not a refusal', () => {
    // OD-2026-08-29-003. Both surfaces used to refuse this clip outright.
    expect(resolveComparisonPair(three, null, null))
      .toEqual({ outcome: 'selection_required', candidates: three });
  });

  test('three readings never auto-pair, not even by the order they arrived', () => {
    // The tempting default. Submission order is incidental to the study, and
    // letting it decide which readings count writes that accident into a
    // table a gold dataset is built from.
    const resolved = resolveComparisonPair(three, null, null);
    expect(resolved.outcome).not.toBe('pair');
  });

  test('a chosen pair is returned, and the other reading is not in it', () => {
    expect(resolveComparisonPair(three, 'set-a', 'set-c'))
      .toEqual({ outcome: 'pair', a: SET_A, b: SET_C });
  });

  test('the order asked for does not decide which reading is A', () => {
    // Canonical order, so two adjudicators picking the same two readings
    // produce the same a/b assignment rather than a difference a later
    // reader would treat as meaningful.
    const asked = resolveComparisonPair(three, 'set-c', 'set-a');
    const reversed = resolveComparisonPair(three, 'set-a', 'set-c');
    expect(asked).toEqual(reversed);
    expect(asked).toEqual({ outcome: 'pair', a: SET_A, b: SET_C });
  });

  test('naming one reading is refused rather than half-honoured', () => {
    expect(() => resolveComparisonPair(three, 'set-a', null))
      .toThrow(/two annotation set ids and one was given/);
  });

  test('a reading cannot be compared with itself', () => {
    expect(() => resolveComparisonPair(three, 'set-a', 'set-a'))
      .toThrow(/the same reading/);
  });

  test('a set that is not on this clip is refused, not fetched', () => {
    // The selection is validated against what the gate returned. Without
    // this, a caller could name a set from another clip or another
    // organization and have it loaded on their behalf.
    expect(() => resolveComparisonPair(three, 'set-a', 'set-from-elsewhere'))
      .toThrow(/not among this clip's submitted readings/);
  });

  test('both ids being foreign is refused, and both are named', () => {
    expect(() => resolveComparisonPair(three, 'set-x', 'set-y'))
      .toThrow(/set-x and set-y/);
  });

  test('fewer than two readings and no choice is refused defensively', () => {
    // The gate refuses zero and one before a caller gets here. This exists so
    // the route does not depend on a refusal one module away.
    expect(() => resolveComparisonPair([SET_A], null, null))
      .toThrow(/1 submitted annotation reading, and a comparison needs two/);
  });
});
