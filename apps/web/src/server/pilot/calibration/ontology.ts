// boxing-ontology-0.1 -- the controlled vocabulary for human video annotation.
//
// WHAT THIS IS. A closed set of OBSERVABLE boxing event labels, ratified by
// the owner, for humans watching footage and recording what they saw. Every
// value below is something an annotator can point at on screen. Nothing below
// is a judgement about quality, effectiveness, intent, or an athlete.
//
// WHY IT IS A MODULE AND NOT A STRING. Two annotators independently labelling
// the same clip is only a measurement if they are choosing from the same list.
// A vocabulary that lives in a form's <option> tags drifts the moment a second
// surface renders it; a vocabulary that lives in a jsonb blob was never a
// vocabulary at all. This module is the single definition, the database CHECK
// constraints are generated from these same arrays, and the version string
// travels with every row so a later change cannot silently reinterpret data
// collected under an earlier one.
//
// WHAT IS DELIBERATELY ABSENT. The owner's order names the concepts that must
// NOT appear yet, each because it requires a definition nobody has ratified:
// fatigue, power punch, punch quality score, technique score, ring control,
// fight IQ, counter opportunity, scoring blow, good/bad defense, good/bad
// guard, recommendation priority. They are absent from this file on purpose.
// If code appears to need one, the dependency stops -- a definition is not
// something this module is allowed to invent.
//
// UNKNOWN IS NOT NO. UNCERTAIN IS NOT NEGATIVE. Several enums below carry an
// explicit 'unknown' or 'uncertain' member. Those are recorded observations --
// "the annotator looked and could not tell" -- and must never be collapsed
// into a negative, an absence, or a default. Where the ontology does NOT
// offer 'unknown', there is no honest way to say it and the field is
// nullable instead, which means "not recorded", a different fact again.
//
// ABSENCE OF ANNOTATION IS NOT ABSENCE OF EVENT. Nothing in this file, and
// nothing that reads it, may treat an unlabelled span of video as evidence
// that nothing happened there.

/** The ontology version stamped onto every calibration project, annotation
 * set, annotation event and adjudicated record.
 *
 * Stored per row rather than looked up globally. A calibration project run in
 * March under 0.1 and one run in July under 0.2 are different measurements,
 * and the only way to keep them from being pooled by accident is for each row
 * to carry the vocabulary it was created under. Nothing in this subsystem is
 * permitted to compare or aggregate across two versions without an explicit
 * decision recorded elsewhere. */
export const BOXING_ONTOLOGY_VERSION = 'boxing-ontology-0.1' as const;
export type BoxingOntologyVersion = typeof BOXING_ONTOLOGY_VERSION;

/* ------------------------------------------------------------------ *
 * EVENT CLASSES
 * ------------------------------------------------------------------ */

/** The two things v0.1 can record. Stored lower-case, matching every other
 * enum in this schema and every CHECK constraint in the repository; the
 * owner's order writes them as headings (PUNCH / DEFENSE) and the SET is
 * unchanged -- this is letter case, not a re-labelling. */
export const EVENT_CLASSES = ['punch', 'defense'] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

/* ------------------------------------------------------------------ *
 * PUNCH
 * ------------------------------------------------------------------ */

/** Punch types, named by HAND ROLE plus TRAJECTORY rather than by the
 * traditional ring names.
 *
 * This is the ontology's most consequential decision and it is deliberate.
 * "Jab" bundles three separate observations into one word: lead hand, straight
 * trajectory, and (usually) head target. An annotator who selects "Jab" has
 * silently asserted all three, and a disagreement about any one of them
 * becomes indistinguishable from a disagreement about the other two. Splitting
 * them means two annotators who agree it was a straight lead-hand punch but
 * disagree about the target produce ONE disagreement in ONE category, which is
 * what a calibration study is trying to measure.
 *
 * `other_punch` is a punch the annotator could classify as none of the above.
 * `unclassifiable_punch` is a punch the annotator could not classify at all --
 * usually because of occlusion. They are different observations and are kept
 * apart: the first says the taxonomy is incomplete, the second says the
 * footage was insufficient, and only one of those is a reason to revise this
 * file. */
export const PUNCH_TYPES = [
  'lead_straight',
  'rear_straight',
  'lead_hook',
  'rear_hook',
  'lead_uppercut',
  'rear_uppercut',
  'other_punch',
  'unclassifiable_punch',
] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];

/** Which physical hand threw it. Kept SEPARATE from hand role on purpose: a
 * southpaw's lead hand is the right, an orthodox fighter's lead is the left,
 * and a fighter mid-switch has neither answer settled. Recording only the role
 * would make left/right unrecoverable, and recording only the hand would make
 * lead/rear unrecoverable -- and the two are the fields most likely to
 * disagree between annotators, which is exactly why they must be measurable
 * apart. */
export const PHYSICAL_HANDS = ['left', 'right', 'unknown'] as const;
export type PhysicalHand = (typeof PHYSICAL_HANDS)[number];

/** Lead or rear, relative to the actor's stance AT THAT MOMENT. */
export const HAND_ROLES = ['lead', 'rear', 'unknown'] as const;
export type HandRole = (typeof HAND_ROLES)[number];

/** The actor's stance at the moment of the event.
 *
 * 'transition' is a real observed state, not a missing value: a fighter caught
 * mid-switch is genuinely in neither stance, and forcing that into orthodox,
 * southpaw or unknown would destroy the observation. It is the state under
 * which hand-role disagreements are most expected, which makes it worth
 * being able to filter by. */
export const STANCES = ['orthodox', 'southpaw', 'transition', 'unknown'] as const;
export type Stance = (typeof STANCES)[number];

/** Where the punch was AIMED. Distinct from CONTACT_ZONES, which is what it
 * actually reached -- a punch aimed at the head that lands on a glove is one
 * observation with two different answers, and the pair is the interesting
 * datum. */
export const TARGET_ZONES = ['head', 'torso', 'unknown'] as const;
export type TargetZone = (typeof TARGET_ZONES)[number];

/** What the punch DID, at the coarsest level an observer can honestly report.
 *
 * 'uncertain_contact' is a first-class recorded outcome and never a synonym
 * for 'no_contact'. An annotator who cannot tell whether a punch landed has
 * observed something different from an annotator who saw it miss, and
 * collapsing the two would manufacture misses out of poor camera angles --
 * the single most likely way for this dataset to become quietly wrong. */
export const CONTACT_RESULTS = [
  'clean_target_contact',
  'glancing_target_contact',
  'guard_contact',
  'non_target_contact',
  'no_contact',
  'uncertain_contact',
] as const;
export type ContactResult = (typeof CONTACT_RESULTS)[number];

/** What surface the punch actually reached.
 *
 * 'none' means the annotator observed that it reached nothing -- a miss.
 * 'unknown' means the annotator could not tell what it reached. Both members
 * exist because those are different observations, and neither may stand in
 * for the other. Shares the tokens 'head' and 'torso' with TARGET_ZONES by
 * design, since a punch can land where it was aimed; the two enums are
 * nonetheless separate types and a validator for one must never accept a
 * value from the other. */
export const CONTACT_ZONES = [
  'head',
  'torso',
  'glove',
  'forearm',
  'arm',
  'non_target',
  'none',
  'unknown',
] as const;
export type ContactZone = (typeof CONTACT_ZONES)[number];

/* ------------------------------------------------------------------ *
 * DEFENSE
 * ------------------------------------------------------------------ */

/** Defensive actions, named by the MOVEMENT observed and never by whether it
 * worked. There is no 'successful_block' and no 'failed_slip' in v0.1: whether
 * a defensive action succeeded is a judgement requiring a ratified rubric,
 * and the order forbids inventing one. Whether the incoming punch landed is
 * already recorded on that punch's own CONTACT_RESULT, which is the honest
 * place for it. */
export const DEFENSE_TYPES = [
  'block',
  'parry',
  'slip',
  'roll_weave',
  'duck',
  'pull_back',
  'step_back',
  'lateral_step',
  'pivot',
  'smother',
  'clinch_defense',
  'other_defense',
  'unclassifiable_defense',
] as const;
export type DefenseType = (typeof DEFENSE_TYPES)[number];

/* ------------------------------------------------------------------ *
 * OBSERVATION QUALITY -- recorded on EVERY event, punch and defense alike
 * ------------------------------------------------------------------ */

/** How well the camera showed it. A property of the FOOTAGE.
 *
 * This is the field that makes a disagreement interpretable. Two annotators
 * disagreeing about a 'clear' event is a vocabulary problem; the same
 * disagreement on a 'partially_occluded' event may be nothing more than the
 * camera angle. Stratifying by this is the difference between a calibration
 * finding and a guess, so it is required on every event and never defaulted. */
export const VISIBILITIES = [
  'clear',
  'partially_occluded',
  'fully_occluded',
  'outside_frame',
  'camera_cut',
] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** How sure the ANNOTATOR was. A property of the PERSON, not the footage.
 *
 * NOTE THE COLLISION: 'clear' is a member of both this enum and VISIBILITIES,
 * and it means different things in each -- "the camera showed it plainly"
 * versus "I am sure of my label". They are separate types for that reason and
 * a shared/generic validator across the two would be a defect, not a
 * simplification. ontology.test.ts asserts the two sets stay distinct in every
 * other member so this hazard cannot widen unnoticed. */
export const ANNOTATION_CERTAINTIES = ['clear', 'probable', 'uncertain'] as const;
export type AnnotationCertainty = (typeof ANNOTATION_CERTAINTIES)[number];

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

/**
 * Membership test for one controlled vocabulary.
 *
 * REJECTS, NEVER COERCES. The owner's order is explicit: an invalid label is
 * rejected input, not a value quietly rewritten to 'unknown'. Coercion would
 * be the worst possible failure here -- it manufactures a recorded observation
 * ("the annotator looked and could not tell") out of a bug, and that
 * fabricated row is indistinguishable from a real one forever after.
 *
 * Deliberately generic over the vocabulary rather than one hand-written guard
 * per enum, so a vocabulary added later cannot arrive without validation. It
 * is NOT generic over which vocabulary a given FIELD accepts -- that mapping
 * is spelled out at each call site, because 'head' being valid for both
 * TARGET_ZONES and CONTACT_ZONES is exactly the kind of overlap a
 * one-size-fits-all validator would wave through.
 */
export function isInVocabulary<T extends string>(
  vocabulary: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/**
 * A SQL `check (col in (...))` fragment built from a vocabulary array.
 *
 * The migration's constraints and this module's arrays must never disagree --
 * a database that accepts a label TypeScript rejects, or vice versa, is a
 * silent data-integrity hole. Rather than trusting two hand-maintained copies
 * to stay aligned, the .pg.test.ts asserts the live constraint text against
 * this function's output, so a value added here and not there fails a test
 * instead of shipping.
 *
 * Values are single-quote escaped even though every current member is
 * `[a-z_]+`. That costs nothing and means this cannot become an injection
 * seam if a future vocabulary is ever built from anything but a literal.
 */
export function vocabularyCheckSql(column: string, vocabulary: readonly string[]): string {
  const quoted = vocabulary.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
  return `check (${column} in (${quoted}))`;
}

/* ------------------------------------------------------------------ *
 * CALIBRATION PROJECT VOCABULARY
 *
 * Not part of the boxing ontology -- these describe the STUDY, not the
 * boxing. They live here because they are controlled vocabularies subject to
 * the same "reject, never coerce" rule, and because a second vocabulary
 * module would be the first step toward two of everything.
 * ------------------------------------------------------------------ */

/** Where a calibration project is in its life.
 *
 * A workflow, not a quality judgement: 'completed' means the study finished
 * its passes, never that its numbers are good. Nothing downstream may read
 * 'completed' as validation of anything. */
export const CALIBRATION_PROJECT_STATUSES = [
  'draft',
  'annotating',
  'adjudicating',
  'completed',
  'archived',
] as const;
export type CalibrationProjectStatus = (typeof CALIBRATION_PROJECT_STATUSES)[number];

/** Why this clip was chosen for the study.
 *
 * This is the stratification key -- the field that turns "annotators
 * disagreed 18% of the time" into "annotators disagreed 4% on isolated
 * punches and 38% on simultaneous exchanges", which is the difference between
 * a number and a finding. It is required on every clip for that reason.
 *
 * It records the SELECTOR'S INTENT at sampling time and is never re-derived
 * from what the annotations later turned out to contain. A clip picked for
 * 'occlusion' that turns out to be perfectly clear stays 'occlusion' -- the
 * sample was drawn that way, and rewriting the reason afterwards would
 * quietly turn a stratified sample into a convenience sample.
 *
 * NOT A QUOTA. The pilot design calls for twenty-four clips across these
 * reasons; that is a design choice for one study, not a property of
 * calibration, and no code in this subsystem enforces a count. */
export const CLIP_SAMPLING_REASONS = [
  'isolated_punch',
  'combination',
  'defense',
  'counter',
  'head_body_mix',
  'opposite_stance',
  'stance_switch',
  'guard_contact',
  'occlusion',
  'simultaneous_exchange',
  'other',
] as const;
export type ClipSamplingReason = (typeof CLIP_SAMPLING_REASONS)[number];
