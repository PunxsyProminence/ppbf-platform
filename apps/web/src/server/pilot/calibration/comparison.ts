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
  /** Always 'UNCALIBRATED' in v0. There is no ratified alternative, and the
   * type says so rather than leaving room for a value nobody has earned. */
  readonly calibrationState: 'UNCALIBRATED';
  /** Milliseconds by which each event's span is widened before testing for
   * overlap.
   *
   * ZERO in the pilot policy, on purpose. The order says to prefer plain
   * temporal overlap first and not to invent a "same event if within 300ms"
   * rule, so the pilot runs with no tolerance at all: two events match only if
   * the spans two humans actually marked genuinely overlap.
   *
   * The knob exists because the pilot will probably show it is needed -- two
   * annotators marking the same punch as [1000,1400] and [1420,1800] produce
   * two EVENT_MISSED here, when what happened was one punch and a boundary
   * disagreement. That is a finding for the calibration study to produce, not
   * a number for this file to guess. */
  readonly overlapToleranceMs: number;
  readonly requireSameActorTrack: boolean;
  readonly requireSameEventClass: boolean;
}

/** The rule the pilot runs under. Uncalibrated, and says so. */
export const PILOT_MATCHING_POLICY_V0_UNCALIBRATED: EventMatchingPolicy = {
  policyVersion: 'pilot-temporal-overlap-v0',
  calibrationState: 'UNCALIBRATED',
  overlapToleranceMs: 0,
  requireSameActorTrack: true,
  requireSameEventClass: true,
};

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

export interface EventPairing {
  outcome: PairingOutcome;
  eventA: AnnotationEventRow | null;
  eventB: AnnotationEventRow | null;
  /** On MATCH_AMBIGUOUS: how many events on the other side this one overlapped.
   * The number is the evidence for why no pairing was forced. */
  candidateCount: number;
  disagreements: Disagreement[];
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

function isCandidate(
  a: AnnotationEventRow,
  b: AnnotationEventRow,
  policy: EventMatchingPolicy,
): boolean {
  if (policy.requireSameEventClass && a.event_class !== b.event_class) return false;
  if (policy.requireSameActorTrack && a.actor_track !== b.actor_track) return false;
  return widenedOverlaps(a, b, policy.overlapToleranceMs);
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
  { field: 'combination_group', category: 'COMBINATION' },
  { field: 'sequence_order', category: 'COMBINATION' },
  { field: 'opponent_track', category: 'OTHER' },
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
): Disagreement[] {
  const disagreements: Disagreement[] = [];

  for (const boundary of ['start_ms', 'end_ms', 'contact_ms', 'peak_ms'] as const) {
    const valueA = a[boundary];
    const valueB = b[boundary];
    if (valueA === valueB) continue;
    disagreements.push({
      category: 'BOUNDARY',
      field: boundary,
      valueA: asComparable(valueA),
      valueB: asComparable(valueB),
      // Only meaningful when both annotators recorded one. A delta against a
      // missing reading would be a number invented out of an absence.
      ...(typeof valueA === 'number' && typeof valueB === 'number'
        ? { deltaMs: valueA - valueB }
        : {}),
    });
  }

  for (const { field, category } of FIELD_CATEGORIES) {
    const valueA = asComparable(a[field]);
    const valueB = asComparable(b[field]);
    if (valueA === valueB) continue;
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

  return disagreements;
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
  policy: EventMatchingPolicy = PILOT_MATCHING_POLICY_V0_UNCALIBRATED,
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

  for (const a of eventsA) {
    for (const b of eventsB) {
      if (!isCandidate(a, b, policy)) continue;
      candidatesForA.get(a.event_id)?.push(b);
      candidatesForB.get(b.event_id)?.push(a);
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
        disagreements: diffMatchedPair(a, b, matchedPartner),
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
      });
      continue;
    }

    pairings.push({
      outcome: 'MATCH_AMBIGUOUS',
      eventA: a,
      eventB: null,
      candidateCount: candidates.length,
      disagreements: [],
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
      });
      continue;
    }

    pairings.push({
      outcome: 'MATCH_AMBIGUOUS',
      eventA: null,
      eventB: b,
      candidateCount: candidates.length,
      disagreements: [],
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
