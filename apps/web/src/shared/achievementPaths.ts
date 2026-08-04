/**
 * THE PROGRESSION CATALOGUE — what this gym measures, for everyone in it.
 *
 * The gym runs four programs: youth mentorship, fitness-only membership, adult
 * recreational boxing, and competitive boxing. Until this file, the platform
 * measured one of them. Achievement was a session count and a set of
 * fight-shaped metrics, so a member who came to get fit and a kid who came for
 * the mentorship both opened a progression system that was not measuring what
 * they came for.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR RULES EVERY ENTRY IN THIS FILE OBEYS
 * ---------------------------------------------------------------------------
 *
 * 1. NOTHING PUNISHES AN ABSENCE. The argument is written out in full at
 *    apps/web/components/TrainingCard.tsx lines 19-24 and it is load-bearing:
 *    this platform has a safety gate that locks athletes out for medical
 *    reasons, so any streak, chain, cadence or expiry would mean an athlete
 *    watching progress die because a doctor protected them — a direct incentive
 *    to hide a concussion, in a contact sport, to children.
 *
 *    Concretely, in this file: every milestone is a THING THAT HAPPENED ONCE,
 *    and every threshold is a CUMULATIVE COUNT that never resets. There is no
 *    field for a window, a period, a frequency, or a deadline, so no entry can
 *    express "in the last N weeks" even by accident. achievementPaths.test.ts
 *    reads the catalogue back and fails on the vocabulary of streaks.
 *
 * 2. NOTHING RANKS ONE ATHLETE AGAINST ANOTHER. No milestone carries points, a
 *    score, a weight or a tier, so there is no per-athlete number to sort. The
 *    only comparison any entry makes is against the athlete's OWN earlier self
 *    ("beat your own mile"), which is a comparison of one person to one person.
 *
 * 3. A PATH IS COMPLETE, NEVER A LADDER WITH RUNGS REMOVED. `tracksFor` returns
 *    which tracks a program shows, and a track a program does not include is
 *    ABSENT rather than greyed out. A fitness-only member does not see a
 *    competition track they can never enter, because a greyed-out rung is how a
 *    system tells somebody they are the incomplete version of somebody else.
 *
 * 4. NOTHING ENCODES HEALTH, INJURY, CLEARANCE OR DISCIPLINE. A milestone
 *    records something an athlete did. It never records a permission they hold,
 *    and no unearned milestone anywhere states a reason it is unearned — every
 *    one of them reads identically as "ahead of you", so the absence of an
 *    award cannot be read backwards into a medical or disciplinary fact.
 *
 * ---------------------------------------------------------------------------
 * `family` IS NOT A DUMBED-DOWN LABEL
 * ---------------------------------------------------------------------------
 *
 * It is the same achievement said to somebody who was not in the room. A parent
 * does not parse RPE or "slip and return", and translating that is not talking
 * down — it is answering the question they actually have, which is whether
 * their kid is showing up, sticking with it, helping anyone, and getting
 * stronger. Both strings describe one fact; neither is truer than the other.
 */

/** The four programs the gym runs. Not a ladder — none of these outranks another. */
export const PROGRAMS = ['fitness', 'youth', 'recreational', 'competitive'] as const;
export type Program = (typeof PROGRAMS)[number];

export function isProgram(value: unknown): value is Program {
  return PROGRAMS.includes(value as Program);
}

/**
 * The default when nobody has said. Not 'competitive': a system that assumes
 * everybody is on the fight path is the system this file replaces.
 */
export const DEFAULT_PROGRAM: Program = 'recreational';

export const TRACKS = ['consistency', 'conditioning', 'craft', 'community', 'competition'] as const;
export type Track = (typeof TRACKS)[number];

export interface TrackMeta {
  readonly key: Track;
  /** What the athlete sees. */
  readonly label: string;
  /** One line of what the track is for, in the athlete's language. */
  readonly blurb: string;
  /** The same track, named for what a parent came to find out. */
  readonly family: string;
}

export const TRACK_META: Readonly<Record<Track, TrackMeta>> = {
  consistency: {
    key: 'consistency',
    label: 'Showing Up',
    blurb: 'Every session you have ever logged, counted once and kept forever.',
    family: 'Showing up',
  },
  conditioning: {
    key: 'conditioning',
    label: 'Engine',
    blurb: 'What your body can do now that it could not do before.',
    family: 'Getting stronger',
  },
  craft: {
    key: 'craft',
    label: 'Craft',
    blurb: 'Technique, worked until it is yours. None of it needs an opponent.',
    family: 'Learning the craft',
  },
  community: {
    key: 'community',
    label: 'The Room',
    blurb: 'What you are to everyone else who trains here.',
    family: 'Helping people',
  },
  competition: {
    key: 'competition',
    label: 'Competition',
    blurb: 'The competitive path, for the people who chose it.',
    family: 'Competing',
  },
};

/**
 * Which tracks each program shows.
 *
 * Four of the five tracks are in every program, which is the whole point: a
 * fitness-only member has a complete progression of thirty-odd milestones, not
 * a boxing ladder with the fighting greyed out. Competition is the one track
 * that is program-specific, and it is ABSENT rather than locked for the others.
 */
const PROGRAM_TRACKS: Readonly<Record<Program, readonly Track[]>> = {
  fitness: ['consistency', 'conditioning', 'craft', 'community'],
  youth: ['consistency', 'conditioning', 'craft', 'community'],
  recreational: ['consistency', 'conditioning', 'craft', 'community'],
  competitive: ['consistency', 'conditioning', 'craft', 'community', 'competition'],
};

export function tracksFor(program: Program | null | undefined): readonly Track[] {
  return PROGRAM_TRACKS[isProgram(program) ? program : DEFAULT_PROGRAM];
}

/**
 * How a milestone is established.
 *
 *   session_count  computed from the training card's own cumulative count.
 *                  Nothing to mark; it lands when it lands.
 *   coach_marked   a coach watched it happen.
 *   self_marked    the athlete did it and says so. A fitness-only member's mile
 *                  is theirs to log; requiring a coach to witness it would make
 *                  half the gym's progression depend on somebody else's shift.
 *   either         coach or athlete, whoever was there.
 */
export type Evidence = 'session_count' | 'coach_marked' | 'self_marked' | 'either';

export interface Milestone {
  /** Stable key. Written to pilot.athlete_milestones and never renamed. */
  readonly key: string;
  readonly track: Track;
  /** What the athlete sees. */
  readonly label: string;
  /** The same thing, for a parent reading over a shoulder. */
  readonly family: string;
  readonly evidence: Evidence;
  /**
   * Only for `session_count`: the CUMULATIVE number of logged sessions that
   * earns it. Cumulative, never consecutive — the count only goes up, and a
   * three-month gap leaves it exactly where it was.
   */
  readonly threshold?: number;
}

/**
 * The consistency thresholds.
 *
 * The training card's own series (TrainingCard.tsx MILESTONES) with a first
 * session added in front of it, because the first time through a gym door is
 * the hardest one and the card started counting at five.
 * achievementPaths.test.ts asserts this stays a superset of the card's series,
 * so the two cannot drift into telling an athlete two different numbers.
 *
 * Fibonacci, like everything else in the system (Law 8).
 */
export const CONSISTENCY_THRESHOLDS = [1, 5, 13, 34, 89, 233] as const;

const CONSISTENCY_MILESTONES: readonly Milestone[] = [
  { key: 'consistency.first_session', track: 'consistency', threshold: 1, evidence: 'session_count',
    label: 'Walked in', family: 'Came in for the first time' },
  { key: 'consistency.5', track: 'consistency', threshold: 5, evidence: 'session_count',
    label: '5 sessions logged', family: 'Has been in five times' },
  { key: 'consistency.13', track: 'consistency', threshold: 13, evidence: 'session_count',
    label: '13 sessions logged', family: 'Has stuck with it — thirteen sessions' },
  { key: 'consistency.34', track: 'consistency', threshold: 34, evidence: 'session_count',
    label: '34 sessions logged', family: 'This is a habit now — thirty-four sessions' },
  { key: 'consistency.89', track: 'consistency', threshold: 89, evidence: 'session_count',
    label: '89 sessions logged', family: 'Eighty-nine sessions. This is who they are now.' },
  { key: 'consistency.233', track: 'consistency', threshold: 233, evidence: 'session_count',
    label: '233 sessions logged', family: 'Two hundred and thirty-three sessions in this gym' },
];

const CONDITIONING_MILESTONES: readonly Milestone[] = [
  { key: 'conditioning.first_full_round', track: 'conditioning', evidence: 'coach_marked',
    label: 'A full round without stopping', family: 'Kept going for a whole round without needing a break' },
  { key: 'conditioning.three_rounds', track: 'conditioning', evidence: 'coach_marked',
    label: 'Three rounds, end to end', family: 'Worked three rounds straight through' },
  { key: 'conditioning.five_rounds', track: 'conditioning', evidence: 'coach_marked',
    label: 'Five rounds, end to end', family: 'Worked five rounds straight through' },
  { key: 'conditioning.mile_unbroken', track: 'conditioning', evidence: 'either',
    label: 'Ran a mile without stopping', family: 'Ran a full mile without stopping to walk' },
  { key: 'conditioning.mile_faster_than_before', track: 'conditioning', evidence: 'either',
    label: 'Beat your own mile', family: 'Beat their own best mile time' },
  { key: 'conditioning.plank_one_minute', track: 'conditioning', evidence: 'either',
    label: 'A minute of plank', family: 'Held a plank for a full minute' },
  { key: 'conditioning.plank_three_minutes', track: 'conditioning', evidence: 'either',
    label: 'Three minutes of plank', family: 'Held a plank for three minutes' },
  { key: 'conditioning.rope_three_minutes', track: 'conditioning', evidence: 'either',
    label: 'Three minutes on the rope, unbroken', family: 'Three minutes of skipping without a trip' },
  { key: 'conditioning.led_own_warmup', track: 'conditioning', evidence: 'coach_marked',
    label: 'Ran your own warm-up start to finish', family: 'Knows the warm-up well enough to run it alone' },
  { key: 'conditioning.first_heavy_bag_round', track: 'conditioning', evidence: 'coach_marked',
    label: 'A full round on the bag', family: 'Worked a whole round on the heavy bag' },
];

const CRAFT_MILESTONES: readonly Milestone[] = [
  { key: 'craft.stance_and_guard', track: 'craft', evidence: 'coach_marked',
    label: 'Stance and guard, without being told', family: 'Stands and guards correctly without reminding' },
  { key: 'craft.jab_lands_clean', track: 'craft', evidence: 'coach_marked',
    label: 'A jab that comes back', family: 'Throws a clean jab and gets the hand back' },
  { key: 'craft.three_punch_combination', track: 'craft', evidence: 'coach_marked',
    label: 'Three punches that belong together', family: 'Puts three punches together properly' },
  { key: 'craft.slip_and_return', track: 'craft', evidence: 'coach_marked',
    label: 'Slip, and answer', family: 'Moves out of the way and answers back' },
  { key: 'craft.footwork_holds_under_fatigue', track: 'craft', evidence: 'coach_marked',
    label: 'Footwork that holds when you are tired', family: 'Keeps their feet right even when tired' },
  { key: 'craft.pads_without_a_reset', track: 'craft', evidence: 'coach_marked',
    label: 'A pad round with no resets', family: 'Worked a full pad round without needing to restart' },
  { key: 'craft.bag_round_with_shape', track: 'craft', evidence: 'coach_marked',
    label: 'A bag round with shape, not swinging', family: 'Works the bag with real technique now' },
  { key: 'craft.taught_it_back', track: 'craft', evidence: 'coach_marked',
    label: 'Taught it to somebody else', family: 'Understands it well enough to teach it' },
  { key: 'craft.wraps_own_hands', track: 'craft', evidence: 'either',
    label: 'Wraps your own hands', family: 'Wraps their own hands properly' },
];

const COMMUNITY_MILESTONES: readonly Milestone[] = [
  { key: 'community.helped_someone_new', track: 'community', evidence: 'coach_marked',
    label: 'Helped somebody new find their feet', family: 'Helped a newer kid settle in' },
  { key: 'community.became_a_mentor', track: 'community', evidence: 'coach_marked',
    label: 'Became somebody’s mentor', family: 'Is mentoring a younger athlete' },
  { key: 'community.left_it_better', track: 'community', evidence: 'coach_marked',
    label: 'Put the room back together, unasked', family: 'Tidies up without being asked' },
  { key: 'community.brought_someone_in', track: 'community', evidence: 'coach_marked',
    label: 'Brought somebody through the door', family: 'Brought a friend into the gym' },
  { key: 'community.spoke_up_for_someone', track: 'community', evidence: 'coach_marked',
    label: 'Spoke up for somebody', family: 'Stood up for someone else' },
  { key: 'community.kept_it_together_outside', track: 'community', evidence: 'either',
    label: 'Held up your end outside the gym', family: 'Keeping up with school or work alongside training' },
  { key: 'community.asked_for_help', track: 'community', evidence: 'either',
    label: 'Asked for help instead of hiding it', family: 'Asked for help when they needed it' },
  { key: 'community.cornered_a_teammate', track: 'community', evidence: 'coach_marked',
    label: 'Worked somebody else’s corner', family: 'Supported a teammate through their session' },
];

/**
 * The competition track. Present only for athletes on the competitive program,
 * and ABSENT — not greyed out — for everybody else.
 *
 * Each of these records something that happened. None of them records a
 * permission: "first sparring round" says a round was worked, it does not say
 * anybody is or is not cleared for contact, and nothing in this file or the UI
 * that renders it ever states why an unearned milestone is unearned.
 */
const COMPETITION_MILESTONES: readonly Milestone[] = [
  { key: 'competition.first_sparring_round', track: 'competition', evidence: 'coach_marked',
    label: 'First round of sparring', family: 'Worked their first round of sparring' },
  { key: 'competition.first_bout', track: 'competition', evidence: 'coach_marked',
    label: 'First bout', family: 'Boxed their first bout' },
  { key: 'competition.came_back_after_a_loss', track: 'competition', evidence: 'coach_marked',
    label: 'Came back in after a loss', family: 'Came back to training after a hard result' },
  { key: 'competition.made_weight_healthily', track: 'competition', evidence: 'coach_marked',
    label: 'Made weight the right way', family: 'Prepared properly for a bout' },
  { key: 'competition.represented_the_gym', track: 'competition', evidence: 'coach_marked',
    label: 'Carried the gym’s name somewhere else', family: 'Represented the gym at an away event' },
];

export const MILESTONES: readonly Milestone[] = [
  ...CONSISTENCY_MILESTONES,
  ...CONDITIONING_MILESTONES,
  ...CRAFT_MILESTONES,
  ...COMMUNITY_MILESTONES,
  ...COMPETITION_MILESTONES,
];

const MILESTONES_BY_KEY: ReadonlyMap<string, Milestone> = new Map(
  MILESTONES.map((milestone) => [milestone.key, milestone]),
);

export function milestoneByKey(key: string): Milestone | null {
  return MILESTONES_BY_KEY.get(key) ?? null;
}

export function isMilestoneKey(value: unknown): value is string {
  return typeof value === 'string' && MILESTONES_BY_KEY.has(value);
}

/** Every milestone in a track, in catalogue order. */
export function milestonesInTrack(track: Track): readonly Milestone[] {
  return MILESTONES.filter((milestone) => milestone.track === track);
}

/**
 * The milestones a program shows. This is the function that makes a
 * fitness-only member's path COMPLETE rather than truncated: what it returns is
 * the whole of that member's progression, with nothing hidden behind a rung
 * they are not allowed to reach.
 */
export function milestonesFor(program: Program | null | undefined): readonly Milestone[] {
  const tracks = new Set(tracksFor(program));
  return MILESTONES.filter((milestone) => tracks.has(milestone.track));
}

/**
 * The keys a cumulative session count has already earned.
 *
 * The ONLY input is the count. Nothing here can see a date, a gap, or an
 * absence, so nothing here can punish one — the same property milestoneCeremony
 * has, and for the same reason.
 */
export function sessionCountMilestoneKeys(completedSessions: number): readonly string[] {
  return CONSISTENCY_MILESTONES
    .filter((milestone) => completedSessions >= (milestone.threshold ?? Number.POSITIVE_INFINITY))
    .map((milestone) => milestone.key);
}

export interface EarnedInput {
  /** Cumulative completed sessions, from the training card's own ledger. */
  readonly completedSessions: number;
  /** Milestone keys awarded in pilot.athlete_milestones. */
  readonly awardedKeys: readonly string[];
}

/**
 * Everything an athlete has earned, count-derived and marked together, in
 * catalogue order and de-duplicated.
 */
export function earnedMilestoneKeys({ completedSessions, awardedKeys }: EarnedInput): readonly string[] {
  const earned = new Set<string>([
    ...sessionCountMilestoneKeys(completedSessions),
    ...awardedKeys.filter((key) => MILESTONES_BY_KEY.has(key)),
  ]);
  return MILESTONES.filter((milestone) => earned.has(milestone.key)).map((milestone) => milestone.key);
}

export interface TrackProgress {
  readonly track: Track;
  readonly meta: TrackMeta;
  readonly earned: readonly Milestone[];
  /**
   * Not "locked". Every one of these reads the same way to every athlete, and
   * none of them carries a reason it is not earned yet.
   */
  readonly ahead: readonly Milestone[];
}

/**
 * One athlete's whole path, track by track.
 *
 * Returns only the tracks their program includes. There is no `available:
 * false` shape and no disabled flag, because a caller cannot render a rung
 * greyed out if it was never handed one.
 */
export function pathProgress(
  program: Program | null | undefined,
  earned: EarnedInput,
): readonly TrackProgress[] {
  const earnedKeys = new Set(earnedMilestoneKeys(earned));

  return tracksFor(program).map((track) => {
    const inTrack = milestonesInTrack(track);
    return {
      track,
      meta: TRACK_META[track],
      earned: inTrack.filter((milestone) => earnedKeys.has(milestone.key)),
      ahead: inTrack.filter((milestone) => !earnedKeys.has(milestone.key)),
    };
  });
}

/* -------------------------------------------------------------------------
 * RECOGNITION — what a coach can say
 *
 * A CLOSED, POSITIVE-ONLY vocabulary, mirrored by the check constraint on
 * pilot.recognitions. Every value is a good thing a person did. There is no
 * severity, no rating and no negative value, so this is not a vocabulary that
 * has been told to stay positive — it is one in which a negative observation
 * cannot be spelled.
 *
 * Each entry is a whole sentence, because it has to arrive reading like
 * something a person said rather than a system notification. The coach picks
 * the sentence; the platform does not compose one out of fields.
 * ------------------------------------------------------------------------- */

export const RECOGNITION_KINDS = [
  'helped_someone',
  'showed_up_hard_day',
  'back_after_a_loss',
  'worked_when_it_was_hard',
  'good_partner',
  'took_the_correction',
  'in_early_and_ready',
  'left_it_better',
  'spoke_up_well',
  'looked_after_someone_new',
] as const;

export type RecognitionKind = (typeof RECOGNITION_KINDS)[number];

export function isRecognitionKind(value: unknown): value is RecognitionKind {
  return RECOGNITION_KINDS.includes(value as RecognitionKind);
}

export interface RecognitionPhrase {
  readonly kind: RecognitionKind;
  /** What the coach taps. Short enough to read at a glance with taped hands. */
  readonly button: string;
  /** What lands on the athlete's wall, in the second person. */
  readonly said: string;
  /** The same thing, told to a parent about their kid. */
  readonly family: string;
}

export const RECOGNITION_PHRASES: readonly RecognitionPhrase[] = [
  { kind: 'helped_someone', button: 'Helped someone',
    said: 'You helped somebody who needed it.',
    family: 'Helped somebody in the gym who needed it.' },
  { kind: 'showed_up_hard_day', button: 'Showed up anyway',
    said: 'You showed up on a day it would have been easy not to.',
    family: 'Came in on a day it would have been easy to skip.' },
  { kind: 'back_after_a_loss', button: 'Came back',
    said: 'You came back in after a rough one. That is the whole thing.',
    family: 'Came back in after a setback.' },
  { kind: 'worked_when_it_was_hard', button: 'Worked when it was hard',
    said: 'You kept working after it stopped being fun.',
    family: 'Kept working when the session got hard.' },
  { kind: 'good_partner', button: 'Good partner',
    said: 'You were a good partner to work with today.',
    family: 'Was a good training partner today.' },
  { kind: 'took_the_correction', button: 'Took the correction',
    said: 'You took a correction and used it in the next round.',
    family: 'Took coaching well and put it straight into practice.' },
  { kind: 'in_early_and_ready', button: 'In early, ready',
    said: 'You were in early and ready to go.',
    family: 'Arrived early and ready to train.' },
  { kind: 'left_it_better', button: 'Left it better',
    said: 'You left this place better than you found it.',
    family: 'Left the gym tidier than they found it.' },
  { kind: 'spoke_up_well', button: 'Said the right thing',
    said: 'You said the right thing at the right time.',
    family: 'Spoke up for someone at the right moment.' },
  { kind: 'looked_after_someone_new', button: 'Looked after a new kid',
    said: 'You looked after somebody who was new and out of their depth.',
    family: 'Looked after somebody new to the gym.' },
];

const RECOGNITION_BY_KIND: ReadonlyMap<string, RecognitionPhrase> = new Map(
  RECOGNITION_PHRASES.map((phrase) => [phrase.kind, phrase]),
);

export function recognitionPhrase(kind: string): RecognitionPhrase | null {
  return RECOGNITION_BY_KIND.get(kind) ?? null;
}

/** The cap the database enforces too. Long enough for a sentence, short enough that it can never be a report. */
export const RECOGNITION_NOTE_MAX = 140;
