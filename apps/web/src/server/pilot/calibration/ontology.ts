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

/* ------------------------------------------------------------------ *
 * VERSIONS
 *
 * The ontology version is stamped onto every calibration project,
 * annotation set, annotation event and adjudicated record.
 *
 * Stored per row rather than looked up globally. A calibration project run in
 * March under 0.1 and one run in July under 0.2 are different measurements,
 * and the only way to keep them from being pooled by accident is for each row
 * to carry the vocabulary it was created under. Nothing in this subsystem is
 * permitted to compare or aggregate across two versions without an explicit
 * decision recorded elsewhere.
 *
 * THERE IS NO "CURRENT VERSION" CONSTANT. Once two versions exist, "the
 * version" means three different things -- what a new study is stamped with,
 * what the labelling page can honestly label, and what may carry body points
 * -- and a single constant would let a call site mean one while saying
 * another. Each question has its own constant below, and every caller names
 * the one it means.
 * ------------------------------------------------------------------ */

/** The event vocabulary of this file's arrays above the BODY POINTS section.
 * Never edited: rows stamped with it keep meaning what they meant. */
export const BOXING_ONTOLOGY_VERSION_0_1 = 'boxing-ontology-0.1' as const;

/** 0.1's event vocabulary unchanged, plus body points marked at three moments,
 * a lead side and a guard at each moment, and a stance type once per event
 * (OD-2026-10-02-008, -011, -014). Defined below under BODY POINTS. */
export const BOXING_ONTOLOGY_VERSION_0_2 = 'boxing-ontology-0.2' as const;

/** 0.2 unchanged, plus one body point: solar_plexus, the bottom tip of the
 * breastbone (Jason 2026-10-03, "add 2 more points center of hips and solar
 * plex", then "ok do it" to: centre of hips is the existing mid_hip, and the
 * new point is the bottom tip of the breastbone). 25 points. */
export const BOXING_ONTOLOGY_VERSION_0_3 = 'boxing-ontology-0.3' as const;

/** Every version this build knows the meaning of. Knowing a version is not the
 * same as being able to label it -- see ANNOTATABLE_ONTOLOGY_VERSIONS. */
export const SUPPORTED_BOXING_ONTOLOGY_VERSIONS = [
  BOXING_ONTOLOGY_VERSION_0_1,
  BOXING_ONTOLOGY_VERSION_0_2,
  BOXING_ONTOLOGY_VERSION_0_3,
] as const;
export type BoxingOntologyVersion = (typeof SUPPORTED_BOXING_ONTOLOGY_VERSIONS)[number];

/** The versions a coach can open and label in this build, and that a project
 * may be created under.
 *
 * 0.1 only, for now. The labelling page's forms and recordAnnotationEvent's
 * checks are 0.1's; opening a 0.2 project would put 0.1's dropdowns in front
 * of a coach and store the answers under a 0.2 stamp. 0.2 joins this list when
 * its rules are enforced and its screen exists -- a code change, never a
 * migration. */
export const ANNOTATABLE_ONTOLOGY_VERSIONS: readonly BoxingOntologyVersion[] = [
  BOXING_ONTOLOGY_VERSION_0_1,
];

/** The versions whose annotation sets may hold body points, lead sides,
 * guards and stance types. A 0.1 set never may (OD-2026-10-02-008 4A: old
 * studies finish on old labels; never mixed). */
export const BODY_POINT_ONTOLOGY_VERSIONS = [
  BOXING_ONTOLOGY_VERSION_0_2,
  BOXING_ONTOLOGY_VERSION_0_3,
] as const satisfies readonly BoxingOntologyVersion[];
export type BodyPointOntologyVersion = (typeof BODY_POINT_ONTOLOGY_VERSIONS)[number];

/** What a new study is stamped with by the routes and the bootstrap. Stays 0.1
 * until 0.2 can be labelled end to end, so no study is created that the
 * current screen cannot label. ontology.test.ts holds it inside
 * ANNOTATABLE_ONTOLOGY_VERSIONS. */
export const PROJECT_CREATION_ONTOLOGY_VERSION: BoxingOntologyVersion = BOXING_ONTOLOGY_VERSION_0_1;

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

/** Where one annotator's pass over one clip is in its life.
 *
 * There is deliberately no 'reopened'. Un-submitting a set would destroy the
 * only evidence that a pass was ever completed independently, and a genuine
 * re-annotation is a NEW set -- which is also the only shape that keeps both
 * readings. The database enforces this with a trigger rather than trusting
 * this constant to be consulted. */
export const ANNOTATION_SET_STATUSES = ['in_progress', 'submitted'] as const;
export type AnnotationSetStatus = (typeof ANNOTATION_SET_STATUSES)[number];

/* ------------------------------------------------------------------ *
 * BODY POINTS -- boxing-ontology-0.2 and later
 *
 * A coach hand-marks where each body point is on the paused picture, at three
 * moments of every punch and every defence (OD-2026-10-02-011 sections 2, 3a).
 * Nothing here is proposed by a machine: there is no pose tool, so there is
 * nothing to accept or correct, and a point is either placed or not visible.
 *
 * Same rules as the rest of this file: every value is something a coach can
 * point at; nothing is a judgement of quality; there is no good or bad guard,
 * no score and no overall number. None of these arrays may be read by a 0.1
 * set (BODY_POINT_ONTOLOGY_VERSIONS).
 * ------------------------------------------------------------------ */

/** 0.2's 24 body points, in the order a coach marks them. Exactly the list
 * Jason ratified (OD-2026-10-02-008 section 2): head (nose, chin); trunk
 * (neck, mid-hip); each arm (shoulder, elbow, wrist, glove); each leg (hip,
 * knee, ankle); each foot (heel, big toe, small toe).
 *
 * Named left and right, never lead and rear: lead and rear are worked out from
 * the lead side at that moment, never clicked (OD-2026-10-02-011 3b). Midline
 * points carry no side. The list can grow, but only as a new ontology version
 * (OD-2026-10-02-008 section 2) -- never by editing this one. */
export const BODY_POINTS_0_2 = [
  'nose',
  'chin',
  'neck',
  'mid_hip',
  'left_shoulder',
  'left_elbow',
  'left_wrist',
  'left_glove',
  'left_hip',
  'left_knee',
  'left_ankle',
  'left_heel',
  'left_big_toe',
  'left_small_toe',
  'right_shoulder',
  'right_elbow',
  'right_wrist',
  'right_glove',
  'right_hip',
  'right_knee',
  'right_ankle',
  'right_heel',
  'right_big_toe',
  'right_small_toe',
] as const;

/** 0.3's 25: 0.2's 24 unchanged and in the same order, then solar_plexus, a
 * midline point with no side. Added at the end so every 0.2 point keeps its
 * position. */
export const BODY_POINTS_0_3 = [...BODY_POINTS_0_2, 'solar_plexus'] as const;

/** Every point any version knows: the database's point-code vocabulary. Which
 * of them a set may hold is its version's list, BODY_POINTS_BY_VERSION; a 0.2
 * set refuses solar_plexus. */
export const BODY_POINTS = BODY_POINTS_0_3;
export type BodyPoint = (typeof BODY_POINTS)[number];

/** The points a set of each body-point version holds at every moment: all of
 * them, and no others, before it can be submitted. */
export const BODY_POINTS_BY_VERSION: Readonly<Record<BodyPointOntologyVersion, readonly BodyPoint[]>> = {
  [BOXING_ONTOLOGY_VERSION_0_2]: BODY_POINTS_0_2,
  [BOXING_ONTOLOGY_VERSION_0_3]: BODY_POINTS_0_3,
};

/** Where to click, for the points Jason gave a rule for (OD-2026-10-02-008
 * section 2; solar_plexus, Jason 2026-10-03). No other placement rule has
 * been written, and none is invented here: a point without an entry has no
 * written rule yet. */
export const BODY_POINT_PLACEMENT_NOTES: Readonly<Partial<Record<BodyPoint, string>>> = {
  chin: 'the tip of the chin',
  solar_plexus: 'the bottom tip of the breastbone',
  left_glove: 'the centre of the padded knuckle area',
  right_glove: 'the centre of the padded knuckle area',
};

/** A point is placed on the picture, or the coach looked and could not see
 * it. Those are the only two states (OD-2026-10-02-011 3a: "not visible" is
 * the only variation). There is no "not marked": a set is not complete until
 * every point has one of these. */
export const BODY_POINT_STATES = ['placed', 'not_visible'] as const;
export type BodyPointState = (typeof BODY_POINT_STATES)[number];

/** The three moments every punch and defence is marked at
 * (OD-2026-10-02-011 3a). Which moment the middle one is depends on the event:
 * see MOMENT_KINDS. */
export const MOMENT_SLOTS = ['start', 'middle', 'end'] as const;
export type MomentSlot = (typeof MOMENT_SLOTS)[number];

/** What a marked moment is.
 *
 * - start, end: the event's own start and end.
 * - contact: the event's contact time, whenever the event has one.
 * - full_extension: a punch with no contact -- "the glove at its furthest
 *   point from the body" (OD-2026-10-02-011 3a). Also a punch where the coach
 *   cannot tell whether it landed (OD-2026-10-02-016 D2 A).
 * - furthest_point: a defence with no contact -- the moment the defending body
 *   part is at its furthest point from where the movement started. The part
 *   is the head for slip, duck, roll_weave and pull_back; the body for
 *   step_back, lateral_step and pivot; the defending glove or forearm for
 *   block, parry, smother and clinch_defense; and the part that moved most for
 *   other_defense and unclassifiable_defense. The rule is the architect's call
 *   (OD-2026-10-02-011 3a), made by the stand-in architect for TEACH-BIOMECH-01
 *   and open to ChatGPT's review.
 *
 * There is no 'peak' (OD-2026-10-02-008 3A). */
export const MOMENT_KINDS = ['start', 'contact', 'full_extension', 'furthest_point', 'end'] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/** In 0.2, the punch results that carry a contact time, and the only ones.
 * A punch that made contact is marked at contact (OD-2026-10-02-011 3a: "start,
 * contact, end"). A miss, and a punch whose landing can't be told, carry none
 * and are marked at full extension (-011 3a; -016 D2 A, which chose full
 * extension over "the coach's best guess of contact"). The
 * calibration-body-point-rules migration holds this on the event row. */
export const CONTACT_RESULTS_WITH_CONTACT: readonly ContactResult[] = [
  'clean_target_contact',
  'glancing_target_contact',
  'guard_contact',
  'non_target_contact',
];

/* Whose points: always the person whose action the event is. There is no
 * subject list and no "opponent": the other boxer is marked on their own event
 * (their defence, and later a received-punch event), never inside the
 * puncher's (Jason 2026-10-03, "It should be on the individuals action" then
 * "1 and 3", superseding OD-2026-10-02-008 9A's marking of the other person
 * on contact). */

/** Which side leads, recorded at each marked moment (OD-2026-10-02-011 3b).
 *
 * - neutral: a square stance, feet level, neither side leading (Jason's
 *   addition, OD-2026-10-02-011 3b).
 * - transition: caught mid-switch, in neither stance. The same observation and
 *   the same token as 0.1's STANCES; one concept, one token.
 * - unknown: the coach could not tell, e.g. the feet are out of frame
 *   (OD-2026-10-02-016 D3 A).
 *
 * In 0.2 this replaces the event-level `stance`: a 0.2 event's `stance` and
 * `peak_ms` stay empty (calibration-body-point-rules migration). */
export const LEAD_SIDES = ['orthodox', 'southpaw', 'neutral', 'transition', 'unknown'] as const;
export type LeadSide = (typeof LEAD_SIDES)[number];

/* ---- Named guards and stance types, by sanctioning body ------------------ *
 *
 * Each sanctioning body's named guards and named stances are separate labels,
 * tagged with their body. No entry is equated with another body's, even where
 * the manuals describe a similar position: each body has its own reasons for
 * its names (OD-2026-10-02-011 3b; OD-2026-10-02-014). None is good or bad.
 *
 * What lives here: the body, the name as the manual prints it, the printed
 * page number and the PDF page index (they differ: USA Boxing's printed page
 * 82 is PDF page 83). What does NOT live here: the manuals' definitions and
 * stated purposes. They are licensed excerpts and are kept privately, never in
 * the public repository (OD-2026-10-02-013 section 2).
 *
 * Every page below was read in that manual's PDF (SOURCE_MANUALS). An entry
 * whose page could not be settled carries a null page and says why; an entry
 * that could not be found at all is left out, never guessed.
 *
 * Left out on purpose: plain orthodox and southpaw stance headings (Boxing
 * Australia's, for one), which are what LEAD_SIDES records; and named
 * defensive techniques such as AIBA's DOUBLE ARM COVER, which are movements,
 * not positions held at a moment. */

export const SANCTIONING_BODIES = ['usa_boxing', 'aiba', 'boxing_australia', 'usiba'] as const;
export type SanctioningBody = (typeof SANCTIONING_BODIES)[number];

export interface SourceManual {
  bodyName: string;
  title: string;
  /** Year or version as the manual states it; null when it states none. */
  edition: string | null;
  url: string;
  /** SHA-256 of the PDF the pages were read in. Page numbers belong to one
   * file; a different upload of "the same" manual may number differently. */
  pdfSha256: string;
}

export const SOURCE_MANUALS: Readonly<Record<SanctioningBody, SourceManual>> = {
  usa_boxing: {
    bodyName: 'USA Boxing',
    title: 'Grassroots Task Force Best Practices Training Manual',
    edition: 'v.01 (2014)',
    url: 'https://d36m266ykvepgv.cloudfront.net/uploads/media/lYivrDbNV6/o/usab-gtf-trainingmanual-v-01-1.pdf',
    pdfSha256: '9b4bcdbdab37a8e15ed1ce6d286803d7c755a49b7fb535a2d80d63cc1a1022e5',
  },
  aiba: {
    bodyName: 'AIBA (now IBA)',
    title: 'AIBA Coach Manual',
    edition: null,
    url: 'https://www.iba.sport/wp-content/uploads/2019/01/AIBA-Coach-Regulations-Manual_WEB_2019_01-1.pdf',
    pdfSha256: '8f829c0dde8368b121d146ecd6e1d11426b531ca3eec713ff91a6396d8171d7a',
  },
  boxing_australia: {
    bodyName: 'Boxing Australia',
    title: 'Coach Manual: Bronze',
    edition: null,
    url: 'https://cdn.revolutionise.com.au/cups/boxing/files/qxpguvjt2cgkasw6.pdf',
    pdfSha256: 'f287fa8daf0df4a3e9d4be3e427ca479f52f14abccea52f5fca4086dc4655f61',
  },
  usiba: {
    bodyName: 'United States Intercollegiate Boxing Association (USIBA)',
    title: 'The Sweet Science 101',
    edition: '2014',
    url: 'https://d36m266ykvepgv.cloudfront.net/uploads/media/U3ycXujQ3J/o/the-sweet-science-101.pdf',
    pdfSha256: 'c668818e2217c3d786ee5f2919c5b8e040d12908b7f6be7caca79d9de995ff4e',
  },
};

export interface NamedPositionSource {
  body: SanctioningBody;
  /** The heading as the manual prints it, letter case included. */
  nameAsPrinted: string;
  /** The page number printed on the manual's page. */
  printedPage: number | null;
  /** The page index in the PDF file (1-based). */
  pdfPage: number | null;
  /** Required exactly when either page is null: why it is not settled. */
  unconfirmed?: string;
}

/** Guard types, recorded at each marked moment (OD-2026-10-02-011 3b). The
 * named guards and arm positions of all four bodies ("Well put all in"),
 * except the AIBA stances that OD-2026-10-02-014 moved to STANCE_TYPES.
 * 'other' and 'unknown' are observations, as everywhere in this file.
 *
 * CLASSIFICATION CALLS, not readings (stand-in architect, accepted by
 * overwatch): AIBA's arm positions printed inside its BOXING STANCE sections
 * (pp. 124-125, 147-151) are guards because they describe the arms; AIBA's
 * stance variations 2 and 3 (pp. 210-211) are guards because they vary the
 * arms, and pair with a stance type recorded once per event; Boxing
 * Australia's double guard (p. 30) is printed as a defensive reaction and is
 * recorded as a guard because it is a position the arms hold. */
export const GUARD_TYPES = [
  'usa_boxing__high_double_guard',
  'usa_boxing__half_guard',
  'aiba__high_shoulder_and_high_lead_arm',
  'aiba__low_arms',
  'aiba__lead_hand_high',
  'aiba__lead_hand_low',
  'aiba__closed_arms_with_bodyweight_to_front',
  'aiba__lower_arms_with_bodyweight_to_front',
  'aiba__lead_hand_high_with_balanced_bodyweight_distribution',
  'aiba__high_guard',
  'aiba__double_guard',
  'aiba__stances_with_closed_guard',
  'aiba__stances_with_arms_down',
  'boxing_australia__closed_guard',
  'boxing_australia__open_guard',
  'boxing_australia__double_guard_to_the_straight',
  'other',
  'unknown',
] as const;
export type GuardType = (typeof GUARD_TYPES)[number];

export const GUARD_TYPE_SOURCES: Readonly<Record<Exclude<GuardType, 'other' | 'unknown'>, NamedPositionSource>> = {
  usa_boxing__high_double_guard: { body: 'usa_boxing', nameAsPrinted: 'High (Double) Guard', printedPage: 82, pdfPage: 83 },
  usa_boxing__half_guard: { body: 'usa_boxing', nameAsPrinted: 'Half Guard', printedPage: 82, pdfPage: 83 },
  aiba__high_shoulder_and_high_lead_arm: { body: 'aiba', nameAsPrinted: 'HIGH SHOULDER AND HIGH LEAD ARM', printedPage: 124, pdfPage: 124 },
  aiba__low_arms: { body: 'aiba', nameAsPrinted: 'LOW ARMS', printedPage: 125, pdfPage: 125 },
  aiba__lead_hand_high: { body: 'aiba', nameAsPrinted: 'LEAD HAND HIGH', printedPage: 147, pdfPage: 147 },
  aiba__lead_hand_low: { body: 'aiba', nameAsPrinted: 'LEAD HAND LOW', printedPage: 148, pdfPage: 148 },
  aiba__closed_arms_with_bodyweight_to_front: { body: 'aiba', nameAsPrinted: 'CLOSED ARMS (WITH BODYWEIGHT TO FRONT)', printedPage: 149, pdfPage: 149 },
  aiba__lower_arms_with_bodyweight_to_front: { body: 'aiba', nameAsPrinted: 'LOWER ARMS (WITH BODYWEIGHT TO FRONT)', printedPage: 150, pdfPage: 150 },
  aiba__lead_hand_high_with_balanced_bodyweight_distribution: { body: 'aiba', nameAsPrinted: 'LEAD HAND HIGH (WITH BALANCED BODYWEIGHT DISTRIBUTION)', printedPage: 151, pdfPage: 151 },
  aiba__high_guard: { body: 'aiba', nameAsPrinted: 'HIGH GUARD', printedPage: 179, pdfPage: 179 },
  aiba__double_guard: { body: 'aiba', nameAsPrinted: 'DOUBLE GUARD', printedPage: 180, pdfPage: 180 },
  aiba__stances_with_closed_guard: { body: 'aiba', nameAsPrinted: 'VARIATION 2: STANCES WITH CLOSED GUARD', printedPage: 210, pdfPage: 210 },
  aiba__stances_with_arms_down: { body: 'aiba', nameAsPrinted: 'VARIATION 3: STANCES WITH ARMS DOWN', printedPage: 211, pdfPage: 211 },
  boxing_australia__closed_guard: { body: 'boxing_australia', nameAsPrinted: 'Closed guard', printedPage: 11, pdfPage: 11 },
  boxing_australia__open_guard: { body: 'boxing_australia', nameAsPrinted: 'Open guard', printedPage: 11, pdfPage: 11 },
  boxing_australia__double_guard_to_the_straight: { body: 'boxing_australia', nameAsPrinted: 'Double Guard to the Straight Lead/Rear Hand', printedPage: 30, pdfPage: 30 },
};

/** Stance types, recorded once per punch or defence (OD-2026-10-02-014), on
 * the event's actor, in pilot.calibration_event_stance_labels. */
export const STANCE_TYPES = [
  'usa_boxing__classic',
  'aiba__weight_to_lead_leg',
  'aiba__weight_to_rear_leg',
  'aiba__up_right_stance',
  'aiba__crouching_stance',
  'aiba__frontal_stance',
  'aiba__frontal_stance_with_closed_arms',
  'aiba__classic',
  'aiba__stance_for_long_distance',
  'aiba__stance_for_medium_distance',
  'aiba__stance_for_short_distance',
  'aiba__stances_with_weight_shift_to_rear_leg',
  'usiba__on_guard',
  'other',
  'unknown',
] as const;
export type StanceType = (typeof STANCE_TYPES)[number];

export const STANCE_TYPE_SOURCES: Readonly<Record<Exclude<StanceType, 'other' | 'unknown'>, NamedPositionSource>> = {
  // OD-2026-10-02-014 calls this "USA Boxing's basic stance"; the manual's
  // heading is "Classic", and its guard entries refer back to it as "the
  // basic stance".
  usa_boxing__classic: { body: 'usa_boxing', nameAsPrinted: 'Classic', printedPage: 82, pdfPage: 83 },
  aiba__weight_to_lead_leg: { body: 'aiba', nameAsPrinted: 'WEIGHT TO LEAD LEG', printedPage: 122, pdfPage: 122 },
  aiba__weight_to_rear_leg: { body: 'aiba', nameAsPrinted: 'WEIGHT TO REAR LEG', printedPage: 123, pdfPage: 123 },
  aiba__up_right_stance: { body: 'aiba', nameAsPrinted: 'UP-RIGHT STANCE', printedPage: 126, pdfPage: 126 },
  aiba__crouching_stance: { body: 'aiba', nameAsPrinted: 'CROUCHING STANCE', printedPage: 127, pdfPage: 127 },
  aiba__frontal_stance: { body: 'aiba', nameAsPrinted: 'FRONTAL STANCE', printedPage: 128, pdfPage: 128 },
  aiba__frontal_stance_with_closed_arms: { body: 'aiba', nameAsPrinted: 'FRONTAL STANCE WITH CLOSED ARMS', printedPage: 152, pdfPage: 152 },
  // Printed as "CLASSIC" twice, in the USA chapter (p. 178) and again in the
  // Cuba chapter (p. 205); one name in one manual is one label.
  aiba__classic: { body: 'aiba', nameAsPrinted: 'CLASSIC', printedPage: 178, pdfPage: 178 },
  aiba__stance_for_long_distance: { body: 'aiba', nameAsPrinted: 'STANCE FOR LONG-DISTANCE', printedPage: 206, pdfPage: 206 },
  aiba__stance_for_medium_distance: { body: 'aiba', nameAsPrinted: 'STANCE FOR MEDIUM-DISTANCE', printedPage: 207, pdfPage: 207 },
  aiba__stance_for_short_distance: { body: 'aiba', nameAsPrinted: 'STANCE FOR SHORT DISTANCE', printedPage: 208, pdfPage: 208 },
  aiba__stances_with_weight_shift_to_rear_leg: { body: 'aiba', nameAsPrinted: 'VARIATION 1: STANCES WITH WEIGHT SHIFT TO REAR LEG', printedPage: 209, pdfPage: 209 },
  // Each PDF page of this book is a two-page spread; PDF page 12 is printed
  // 14-15. The book's contents page starts "Head and Hand Position" on 15, and
  // this heading follows that section's opening sentence, so it is on 15. The
  // heading is set in small capitals; its letter case here is a reading.
  usiba__on_guard: { body: 'usiba', nameAsPrinted: 'Orthodox Hand Position (On-Guard)', printedPage: 15, pdfPage: 12 },
};
