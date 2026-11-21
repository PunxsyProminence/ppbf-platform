import type { AnnotationEventRow, AnnotationSetRow } from './annotations';

// Where two annotators disagreed -- a DERIVED read model over two submitted
// sets, computed on read and stored nowhere.
//
// WHY NOTHING IS PERSISTED. Both inputs are frozen: a submitted annotation set
// cannot be inserted into, updated, or deleted from (the triggers in the
// annotations migration). A derivation over immutable inputs is the same every
// time it runs, so a stored copy could only ever be identical or stale. The
// order says the comparison must not rewrite source annotations; not writing
// anything at all is the strongest available form of that.
//
// NO OVERALL SCORE. There is deliberately no agreement rate, no kappa, no
// "ontology confidence", and no scalar anywhere in the result. Collapsing
// fifteen disagreement categories into one number requires weights nobody has
// measured, and the number would immediately be read as a verdict on the
// annotators. A test asserts the result carries no such property, the same
// guard the pattern-formation contract keeps for the same reason.
//
// THIS MEASURES THE ANNOTATION PROCESS. It says nothing about any athlete, and
// nothing about the model. Two annotators disagreeing about a punch is a fact
// about the vocabulary, the footage, and the two people -- in some mixture
// this module cannot separate and does not try to.
//
// ANNOTATOR AGREEMENT IS NOT MODEL ACCURACY, and neither is a substitute for
// the other. Nothing here touches Film Study.

/** The categories a disagreement can fall into. Exactly the owner's list.
 *
 * Uppercase, because these are markers meant to survive being copied into a
 * spreadsheet or an issue -- the same reason DENOMINATOR_NOT_CAPTURED and
 * NEEDS_OWNER_CLASSIFICATION are uppercase elsewhere in this codebase.
 *
 * OTHER is last and is a real bucket, not a default. It catches a difference
 * in a field that has no category of its own; if it ever starts accumulating,
 * that is evidence the list needs a new member, which is an owner decision. */
export const DISAGREEMENT_CATEGORIES = [
  'EVENT_MISSED',
  'BOUNDARY',
  'PUNCH_TYPE',
  'PHYSICAL_HAND',
  'HAND_ROLE',
  'STANCE',
  'TARGET',
  'CONTACT_RESULT',
  'CONTACT_ZONE',
  'DEFENSE_TYPE',
  'COMBINATION',
  'COUNTER',
  'VISIBILITY',
  'CERTAINTY',
  'OTHER',
] as const;
export type DisagreementCategory = (typeof DISAGREEMENT_CATEGORIES)[number];

/**
 * How two events were paired, or why they were not.
 *
 * MATCH_AMBIGUOUS is a first-class outcome and not a failure. When one
 * annotator marks one long exchange and the other marks three punches inside
 * it, there is no honest pairing -- and forcing one would invent a
 * correspondence that then gets counted as agreement or disagreement about a
 * field, neither of which happened. Reporting the ambiguity keeps the
 * uncertainty visible to whoever adjudicates it.
 */
export type PairingOutcome = 'MATCHED' | 'MATCH_AMBIGUOUS' | 'ONLY_IN_A' | 'ONLY_IN_B';

/**
 * The rule for deciding two events describe the same moment.
 *
 * VERSIONED AND MARKED UNCALIBRATED, because it is neither measured nor
 * ratified. The owner's order is explicit that a matching tolerance must not
 * ship as a bare constant pretending to be a fact, so the version and the
 * calibration state travel inside every comparison this module produces --
 * a result read six months from now still says what rule produced it.
 *
 * Deliberately NOT named with DEFAULT, STANDARD or RECOMMENDED. The pattern
 * formation module keeps a test asserting no export matches those words
 * (patterns/policy.test.ts), on the grounds that a threshold named "default"
 * stops being read as a choice somebody made. The same reasoning applies here
 * and this module keeps the same guard.
 */
export interface EventMatchingPolicy {
  readonly policyVersion: string;
  /** Always 'UNCALIBRATED'. v1's window is the number the owner's ruling was
   * asked as, not one measured on pilot pairs, and the type says so rather
   * than leaving room for a value nobody has earned. */
  readonly calibrationState: 'UNCALIBRATED';
  /** The window, in milliseconds. It does two things, both from one ruling:
   *
   * 1. Two events whose spans come within this many ms of each other are
   *    candidates for the same moment -- but only when neither overlaps any
   *    event on the other side (see compareAnnotationSets: the window rescues
   *    a near miss and never re-pairs marks that already overlap).
   * 2. On a matched pair, two readings of a start, contact, end or peak that
   *    differ by this many ms or less are not a BOUNDARY disagreement.
   *
   * OD-2026-10-08-005 A-Q10c, Jason: "Allow a small window (Recommended)";
   * ruling 3: "two coaches' marks within a small window count as the same
   * punch; the lane tunes the number (asked as about 100 ms) and shows it on
   * screen". v0 ran with 0 -- marks of one punch at [1000,1400] and
   * [1420,1800] were two EVENT_MISSED, and a start 1 ms apart was a
   * disagreement. That was lane HF6's finding; v1 is the fix. */
  readonly overlapToleranceMs: number;
  readonly requireSameActorTrack: boolean;
  readonly requireSameEventClass: boolean;
}

/** The first pilot rule: no window at all. Kept, unchanged, so a stored or
 * pasted result that names it still means what it meant. */
export const PILOT_MATCHING_POLICY_V0_UNCALIBRATED: EventMatchingPolicy = {
  policyVersion: 'pilot-temporal-overlap-v0',
  calibrationState: 'UNCALIBRATED',
  overlapToleranceMs: 0,
  requireSameActorTrack: true,
  requireSameEventClass: true,
};

/** The rule the pilot runs under now: A-Q10c's small window, at the 100 ms it
 * was asked as (OD-2026-10-08-005 ruling 3). Tuning it on pilot pairs is a
 * later item (Overwatch, TEACH-T Q4); a tuned number is a new version, never
 * an edit to this one. Uncalibrated, and says so. */
export const PILOT_MATCHING_POLICY_V1_UNCALIBRATED: EventMatchingPolicy = {
  policyVersion: 'pilot-temporal-overlap-v1',
  calibrationState: 'UNCALIBRATED',
  overlapToleranceMs: 100,
  requireSameActorTrack: true,
  requireSameEventClass: true,
};

/** The rule a comparison uses when the caller names none. */
export const PILOT_MATCHING_POLICY_IN_USE: EventMatchingPolicy = PILOT_MATCHING_POLICY_V1_UNCALIBRATED;

export interface Disagreement {
  category: DisagreementCategory;
  /** The field the two readings differ on, as stored. */
  field: string;
  valueA: string | null;
  valueB: string | null;
  /** Present only on BOUNDARY: how far apart the two readings were, in
   * milliseconds, signed as (A - B). Reported per boundary rather than
   * summed, because a start that is 40ms early and an end that is 40ms late
   * is a different observation from both being 40ms early. */
  deltaMs?: number;
}

/** How far apart two readings of one time were, on a matched pair, whether or
 * not that counts as a disagreement. Signed as (A - B). */
export interface BoundaryDelta {
  field: 'start_ms' | 'end_ms' | 'contact_ms' | 'peak_ms';
  deltaMs: number;
}

export interface EventPairing {
  outcome: PairingOutcome;
  eventA: AnnotationEventRow | null;
  eventB: AnnotationEventRow | null;
  /** On MATCH_AMBIGUOUS: how many events on the other side this one overlapped.
   * The number is the evidence for why no pairing was forced. */
  candidateCount: number;
  disagreements: Disagreement[];
  /** Every non-zero difference between two recorded times on a MATCHED pair,
   * including those inside the window that are not disagreements. The timing
   * figures read this, so hiding a 40 ms difference from the disagreement list
   * does not hide it from "how far apart were the marks". Empty on every
   * other outcome. */
  boundaryDeltas: BoundaryDelta[];
}

export interface AnnotationSetComparison {
  organizationId: string;
  calibrationClipId: string;
  annotationSetIdA: string;
  annotationSetIdB: string;
  annotatorAccountIdA: string;
  annotatorAccountIdB: string;
  /** Stamped into the output so a stored or pasted result still names the rule
   * that produced it. */
  matchingPolicy: EventMatchingPolicy;
  /** The ontology both sets were collected under. Comparison across two
   * versions is refused rather than performed -- see compareAnnotationSets. */
  ontologyVersion: string;
  pairings: EventPairing[];
}

/** Raised rather than returning a comparison that would be meaningless. */
export class ComparisonNotEligibleError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ComparisonNotEligibleError';
    this.reason = reason;
  }
}

/**
 * WHICH TWO READINGS, WHEN THERE ARE MORE THAN TWO.
 *
 * OD-2026-08-29-003. Nothing caps annotators per clip and compareAnnotationSets
 * takes exactly two, so a clip with three submitted readings has no pair until
 * someone names one. Both surfaces used to refuse that clip outright, which was
 * correct as a way of not inventing a study rule and is now superseded: the
 * adjudicator picks the pair, and the choice is a person's rather than an
 * artefact of row order.
 *
 * WHAT THIS REFUSES TO DO. It does not choose for the caller. Two submitted
 * readings still pair themselves, because there is only one pair to make and
 * asking would be ceremony. Three or more never auto-pairs, not even by
 * created_at: picking the two earliest would let submission order -- which is
 * incidental to the study -- decide which readings count, in a table a gold
 * dataset is later built from.
 *
 * THE SELECTION IS VALIDATED, NEVER TRUSTED. `sets` is what the blinding gate
 * returned for this clip and this organization. A requested id that is not in
 * it is refused rather than looked up, so a caller cannot name a set from
 * another clip, another organization, or an unsubmitted reading and have it
 * fetched on their behalf. This is the same posture the routes already take
 * with adjudicator identity and set ids: the caller may say WHICH, never WHAT.
 *
 * ORDER IS CANONICAL, NOT AS ASKED. The returned pair follows the order in
 * `sets`, so two adjudicators who pick the same two readings produce the same
 * a/b assignment. Taking the caller's order would make
 * annotation_set_id_a/_b depend on which box a person filled first, and two
 * records of the same decision would then differ in a column a later reader
 * would reasonably treat as meaningful.
 */
export type PairResolution<T> =
  | { readonly outcome: 'pair'; readonly a: T; readonly b: T }
  /** Three or more readings and no choice made yet. Not an error: the surface
   *  is expected to offer these and ask. */
  | { readonly outcome: 'selection_required'; readonly candidates: readonly T[] };

export function resolveComparisonPair<T extends { readonly annotation_set_id: string }>(
  sets: readonly T[],
  requestedA: string | null,
  requestedB: string | null,
): PairResolution<T> {
  /* A CHOICE ONLY EXISTS WHERE THERE IS ONE TO MAKE.
   *
   * At two readings there is exactly one pair, and it comes from the gate's
   * own list either way, so a requested pair is ignored rather than
   * validated. That keeps the contract the adjudication route was built and
   * tested on -- a body claiming which readings were weighed changes
   * nothing -- and confines OD-2026-08-29-003 to the case it actually
   * ruled on. Widening the refusal to two-reading clips would be a second,
   * unratified change riding along with this one.
   */
  if (sets.length === 2) return { outcome: 'pair', a: sets[0], b: sets[1] };

  const wanted = [requestedA, requestedB].filter((id): id is string => Boolean(id && id.trim()));

  if (wanted.length === 1) {
    throw new ComparisonNotEligibleError(
      'INCOMPLETE_PAIR_SELECTION',
      'Forbidden: a pair needs two annotation set ids and one was given. Naming one reading '
      + 'and letting the build choose the other would be the row-order default this asks a '
      + 'person to replace.',
    );
  }

  if (wanted.length === 2) {
    if (wanted[0] === wanted[1]) {
      throw new ComparisonNotEligibleError(
        'PAIR_IS_ONE_READING',
        'Forbidden: the two annotation set ids are the same reading. A comparison of a '
        + 'reading with itself has no disagreement to find.',
      );
    }
    const chosen = wanted.map((id) => sets.find((set) => set.annotation_set_id === id));
    const missing = wanted.filter((_, i) => chosen[i] === undefined);
    if (missing.length > 0) {
      throw new ComparisonNotEligibleError(
        'PAIR_NOT_ON_THIS_CLIP',
        `Forbidden: ${missing.length === 1 ? 'annotation set' : 'annotation sets'} `
        + `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not among this `
        + "clip's submitted readings. A pair is chosen from what the clip has, not supplied.",
      );
    }
    // Canonical order, per the docblock -- not the order asked for.
    const inOrder = sets.filter((set) => wanted.includes(set.annotation_set_id));
    return { outcome: 'pair', a: inOrder[0], b: inOrder[1] };
  }

  if (sets.length === 2) return { outcome: 'pair', a: sets[0], b: sets[1] };
  if (sets.length > 2) return { outcome: 'selection_required', candidates: sets };

  // Fewer than two with nothing requested. resolveAdjudicationEligibility
  // refuses zero and one before a caller reaches here, so this is defensive:
  // a route whose correctness depends on a refusal one module away breaks
  // silently the day that module is widened.
  throw new ComparisonNotEligibleError(
    'NOT_ENOUGH_READINGS',
    `Forbidden: this clip has ${sets.length} submitted annotation `
    + `${sets.length === 1 ? 'reading' : 'readings'}, and a comparison needs two.`,
  );
}

function widenedOverlaps(
  a: AnnotationEventRow,
  b: AnnotationEventRow,
  toleranceMs: number,
): boolean {
  // Half-open at neither end: two events that merely touch at a single
  // millisecond do overlap. At tolerance 0 that is the loosest honest reading
  // of "the spans a human marked describe the same moment".
  return a.start_ms - toleranceMs <= b.end_ms && b.start_ms - toleranceMs <= a.end_ms;
}

/**
 * A coach-typed label, with only its formatting taken out: letter case, and
 * runs of whitespace (collapsed to one space; none at either end). Nothing
 * else -- "Fighter 1" and "fighter  1" are one label; "Fighter 1" and
 * "fighter_1" are not.
 *
 * Overwatch's application of the HF6 finding (TEACH-T, Q5): a difference
 * that is only formatting is not a disagreement. Used ONLY to compare the
 * three free-text fields (actor_track, opponent_track, combination_group);
 * stored rows are frozen and never rewritten, and a reported disagreement
 * still shows both values exactly as stored.
 */
export function foldFreeTextLabel(value: string | null): string | null {
  if (value === null) return null;
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameKind(
  a: AnnotationEventRow,
  b: AnnotationEventRow,
  policy: EventMatchingPolicy,
): boolean {
  if (policy.requireSameEventClass && a.event_class !== b.event_class) return false;
  if (
    policy.requireSameActorTrack
    && foldFreeTextLabel(a.actor_track) !== foldFreeTextLabel(b.actor_track)
  ) return false;
  return true;
}

/** The per-field comparisons for a matched pair.
 *
 * Ordered as the owner's category list is, so a reader comparing this table to
 * the order can check it member by member. Every ontology field that can
 * differ has a category; the ones with no category of their own fall to OTHER
 * rather than being dropped, because a silently uncompared field would read as
 * agreement. */
const FIELD_CATEGORIES: Array<{
  field: keyof AnnotationEventRow;
  category: DisagreementCategory;
  /** A coach types this field, so it is compared through foldFreeTextLabel. */
  freeText?: true;
}> = [
  { field: 'punch_type', category: 'PUNCH_TYPE' },
  { field: 'physical_hand', category: 'PHYSICAL_HAND' },
  { field: 'hand_role', category: 'HAND_ROLE' },
  { field: 'stance', category: 'STANCE' },
  { field: 'target_zone', category: 'TARGET' },
  { field: 'contact_result', category: 'CONTACT_RESULT' },
  { field: 'contact_zone', category: 'CONTACT_ZONE' },
  { field: 'defense_type', category: 'DEFENSE_TYPE' },
  { field: 'visibility', category: 'VISIBILITY' },
  { field: 'certainty', category: 'CERTAINTY' },
  { field: 'combination_group', category: 'COMBINATION', freeText: true },
  { field: 'sequence_order', category: 'COMBINATION' },
  { field: 'opponent_track', category: 'OTHER', freeText: true },
];

function asComparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Whether the two readings of a relationship agree.
 *
 * COMPARING THE RAW IDS WOULD BE MEANINGLESS. Every event id is unique to one
 * annotator's set, so annotator A's counter_against_event_id can never equal
 * annotator B's -- a naive comparison would report a COUNTER disagreement on
 * every single countered punch, which is worse than not comparing at all
 * because it looks like a finding.
 *
 * What is actually being asked is: did they point at the same MOMENT? So the
 * targets are resolved through the pairing that has already been established.
 * They agree when both point at nothing, or when both point at events that
 * were matched to each other.
 */
function relationshipAgrees(
  targetA: string | null,
  targetB: string | null,
  matchedPartner: ReadonlyMap<string, string>,
): boolean {
  if (targetA === null && targetB === null) return true;
  if (targetA === null || targetB === null) return false;
  return matchedPartner.get(targetA) === targetB;
}

function diffMatchedPair(
  a: AnnotationEventRow,
  b: AnnotationEventRow,
  matchedPartner: ReadonlyMap<string, string>,
  policy: EventMatchingPolicy,
): { disagreements: Disagreement[]; boundaryDeltas: BoundaryDelta[] } {
  const disagreements: Disagreement[] = [];
  const boundaryDeltas: BoundaryDelta[] = [];

  for (const boundary of ['start_ms', 'end_ms', 'contact_ms', 'peak_ms'] as const) {
    const valueA = a[boundary];
    const valueB = b[boundary];
    if (valueA === valueB) continue;
    // Only meaningful when both annotators recorded one. A delta against a
    // missing reading would be a number invented out of an absence -- and one
    // reading present and the other absent is always a disagreement, however
    // wide the window.
    const bothRecorded = typeof valueA === 'number' && typeof valueB === 'number';
    if (bothRecorded) {
      const deltaMs = valueA - valueB;
      boundaryDeltas.push({ field: boundary, deltaMs });
      // Inside the window: the same moment marked a few ms apart (A-Q10c).
      if (Math.abs(deltaMs) <= policy.overlapToleranceMs) continue;
    }
    disagreements.push({
      category: 'BOUNDARY',
      field: boundary,
      valueA: asComparable(valueA),
      valueB: asComparable(valueB),
      ...(bothRecorded ? { deltaMs: (valueA as number) - (valueB as number) } : {}),
    });
  }

  for (const { field, category, freeText } of FIELD_CATEGORIES) {
    const valueA = asComparable(a[field]);
    const valueB = asComparable(b[field]);
    if (valueA === valueB) continue;
    if (freeText && foldFreeTextLabel(valueA) === foldFreeTextLabel(valueB)) continue;
    disagreements.push({ category, field, valueA, valueB });
  }

  if (!relationshipAgrees(a.counter_against_event_id, b.counter_against_event_id, matchedPartner)) {
    disagreements.push({
      category: 'COUNTER',
      field: 'counter_against_event_id',
      valueA: a.counter_against_event_id,
      valueB: b.counter_against_event_id,
    });
  }
  if (!relationshipAgrees(a.defends_against_event_id, b.defends_against_event_id, matchedPartner)) {
    disagreements.push({
      category: 'COUNTER',
      field: 'defends_against_event_id',
      valueA: a.defends_against_event_id,
      valueB: b.defends_against_event_id,
    });
  }

  return { disagreements, boundaryDeltas };
}

/**
 * Compares two submitted annotation sets over the same clip.
 *
 * PURE. No I/O, no clock, no randomness -- the same inputs give the same
 * output forever, which is what lets a comparison be recomputed rather than
 * stored.
 *
 * REFUSES rather than producing a misleading answer when the two sets are not
 * comparable: unsubmitted (an in-progress set is not a reading, it is a
 * reading in progress), different clips, different annotators required, or
 * two different ontology versions. Two vocabularies are two measurements and
 * pooling them would manufacture disagreements out of a renamed label.
 */
export function compareAnnotationSets(
  setA: AnnotationSetRow,
  eventsA: readonly AnnotationEventRow[],
  setB: AnnotationSetRow,
  eventsB: readonly AnnotationEventRow[],
  policy: EventMatchingPolicy = PILOT_MATCHING_POLICY_IN_USE,
): AnnotationSetComparison {
  if (setA.organization_id !== setB.organization_id) {
    throw new ComparisonNotEligibleError(
      'CROSS_ORGANIZATION',
      'Forbidden: two annotation sets from different organizations cannot be compared',
    );
  }
  if (setA.calibration_clip_id !== setB.calibration_clip_id) {
    throw new ComparisonNotEligibleError(
      'DIFFERENT_CLIPS',
      'Missing calibration_clip_id: two annotation sets about different clips cannot be compared',
    );
  }
  if (setA.annotation_set_id === setB.annotation_set_id) {
    throw new ComparisonNotEligibleError(
      'SAME_SET',
      'Missing annotation_set_id: a set cannot be compared with itself',
    );
  }
  if (setA.annotator_account_id === setB.annotator_account_id) {
    throw new ComparisonNotEligibleError(
      'SAME_ANNOTATOR',
      'Missing annotator_account_id: two readings by one annotator are not independent',
    );
  }
  if (setA.status !== 'submitted' || setB.status !== 'submitted') {
    throw new ComparisonNotEligibleError(
      'NOT_BOTH_SUBMITTED',
      'Forbidden: both annotation sets must be submitted before they can be compared',
    );
  }
  if (setA.ontology_version !== setB.ontology_version) {
    throw new ComparisonNotEligibleError(
      'ONTOLOGY_VERSION_MISMATCH',
      'Missing ontology_version: sets collected under different vocabularies are different measurements',
    );
  }

  // Candidate graph, both directions. Built before anything is decided,
  // because whether a pairing is ambiguous depends on what ELSE overlaps it.
  const candidatesForA = new Map<string, AnnotationEventRow[]>();
  const candidatesForB = new Map<string, AnnotationEventRow[]>();
  for (const a of eventsA) candidatesForA.set(a.event_id, []);
  for (const b of eventsB) candidatesForB.set(b.event_id, []);

  // FIRST, SPANS THAT REALLY OVERLAP. Exactly v0's rule.
  for (const a of eventsA) {
    for (const b of eventsB) {
      if (!sameKind(a, b, policy) || !widenedOverlaps(a, b, 0)) continue;
      candidatesForA.get(a.event_id)?.push(b);
      candidatesForB.get(b.event_id)?.push(a);
    }
  }

  // THEN THE WINDOW, ONLY FOR EVENTS THAT OVERLAP NOTHING (A-Q10c). Widening
  // every span would make two different punches of a fast combination --
  // marked by both coaches, 80 ms apart -- candidates for each other, and a
  // pair that really overlaps would turn MATCH_AMBIGUOUS. So the window only
  // rescues a near miss: an event with no overlapping partner, near an event
  // on the other side that has none either. Two marks that overlap are paired
  // exactly as v0 paired them.
  if (policy.overlapToleranceMs > 0) {
    const unpairedB = eventsB.filter((b) => (candidatesForB.get(b.event_id) ?? []).length === 0);
    for (const a of eventsA) {
      if ((candidatesForA.get(a.event_id) ?? []).length > 0) continue;
      for (const b of unpairedB) {
        if (!sameKind(a, b, policy) || !widenedOverlaps(a, b, policy.overlapToleranceMs)) continue;
        candidatesForA.get(a.event_id)?.push(b);
        candidatesForB.get(b.event_id)?.push(a);
      }
    }
  }

  // A pairing is only unambiguous when it is one-to-one from BOTH sides.
  // Checking only A's side would pair A's single punch with B's long exchange
  // that also covers two other punches -- a correspondence neither annotator
  // asserted.
  const matchedPartner = new Map<string, string>();
  for (const a of eventsA) {
    const candidates = candidatesForA.get(a.event_id) ?? [];
    if (candidates.length !== 1) continue;
    const b = candidates[0];
    if ((candidatesForB.get(b.event_id) ?? []).length !== 1) continue;
    matchedPartner.set(a.event_id, b.event_id);
    matchedPartner.set(b.event_id, a.event_id);
  }

  const pairings: EventPairing[] = [];

  for (const a of eventsA) {
    const candidates = candidatesForA.get(a.event_id) ?? [];
    const partnerId = matchedPartner.get(a.event_id);

    if (partnerId !== undefined) {
      const b = eventsB.find((event) => event.event_id === partnerId) as AnnotationEventRow;
      pairings.push({
        outcome: 'MATCHED',
        eventA: a,
        eventB: b,
        candidateCount: 1,
        ...diffMatchedPair(a, b, matchedPartner, policy),
      });
      continue;
    }

    if (candidates.length === 0) {
      // Nothing on B's side overlapped it at all. One annotator recorded an
      // event the other did not -- which is NOT proof the event did not
      // happen, only that it was not annotated.
      pairings.push({
        outcome: 'ONLY_IN_A',
        eventA: a,
        eventB: null,
        candidateCount: 0,
        disagreements: [
          { category: 'EVENT_MISSED', field: 'event_id', valueA: a.event_id, valueB: null },
        ],
        boundaryDeltas: [],
      });
      continue;
    }

    pairings.push({
      outcome: 'MATCH_AMBIGUOUS',
      eventA: a,
      eventB: null,
      candidateCount: candidates.length,
      disagreements: [],
      boundaryDeltas: [],
    });
  }

  for (const b of eventsB) {
    if (matchedPartner.has(b.event_id)) continue;
    const candidates = candidatesForB.get(b.event_id) ?? [];

    if (candidates.length === 0) {
      pairings.push({
        outcome: 'ONLY_IN_B',
        eventA: null,
        eventB: b,
        candidateCount: 0,
        disagreements: [
          { category: 'EVENT_MISSED', field: 'event_id', valueA: null, valueB: b.event_id },
        ],
        boundaryDeltas: [],
      });
      continue;
    }

    pairings.push({
      outcome: 'MATCH_AMBIGUOUS',
      eventA: null,
      eventB: b,
      candidateCount: candidates.length,
      disagreements: [],
      boundaryDeltas: [],
    });
  }

  // Stable order so two runs of the same comparison read identically. Sorted
  // by whichever event is present, so an ONLY_IN_B pairing still lands in
  // timeline order beside the matched ones.
  pairings.sort((left, right) => {
    const leftStart = left.eventA?.start_ms ?? left.eventB?.start_ms ?? 0;
    const rightStart = right.eventA?.start_ms ?? right.eventB?.start_ms ?? 0;
    if (leftStart !== rightStart) return leftStart - rightStart;
    const leftId = left.eventA?.event_id ?? left.eventB?.event_id ?? '';
    const rightId = right.eventA?.event_id ?? right.eventB?.event_id ?? '';
    return leftId.localeCompare(rightId);
  });

  return {
    organizationId: setA.organization_id,
    calibrationClipId: setA.calibration_clip_id,
    annotationSetIdA: setA.annotation_set_id,
    annotationSetIdB: setB.annotation_set_id,
    annotatorAccountIdA: setA.annotator_account_id,
    annotatorAccountIdB: setB.annotator_account_id,
    matchingPolicy: policy,
    ontologyVersion: setA.ontology_version,
    pairings,
  };
}

/**
 * Counts per disagreement category. Counts, not rates.
 *
 * NO DENOMINATOR IS SUPPLIED HERE, deliberately. A rate needs a decision about
 * what it is a rate OF -- events, matched pairs, comparable fields -- and each
 * of those answers a different question. Handing back a count per category
 * leaves that choice where it belongs, with whoever is asking, instead of
 * baking one reading into the module every later caller inherits.
 */
export function countDisagreementsByCategory(
  comparison: AnnotationSetComparison,
): Record<DisagreementCategory, number> {
  const counts = Object.fromEntries(
    DISAGREEMENT_CATEGORIES.map((category) => [category, 0]),
  ) as Record<DisagreementCategory, number>;

  for (const pairing of comparison.pairings) {
    for (const disagreement of pairing.disagreements) {
      counts[disagreement.category] += 1;
    }
  }
  return counts;
}
