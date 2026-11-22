/**
 * The approved bar, applied: is a coach-observed behaviour EMERGING, a
 * PATTERN, or ESTABLISHED for one athlete? (lane L49; Jason 2026-10-18 approved
 * the threshold research, rows P1-P6, pick 1 "A: Adopt as written (Rec.)",
 * and pick 3 "A: Not until calibrated (Rec.)".) The bar's numbers are the
 * gym's ratified version (learningPolicies.ts PatternFormationBar); none is
 * written here.
 *
 * WHAT IS COUNTED. Attempts, not readings (./episodes.ts): a coded chance is
 * one attempt a COACH scored present or absent (report P1), so several reports
 * of one rep are one chance, and film or a model reading alone is none.
 *   P1 sessions      distinct sessions with a coded chance
 *   P2 chances       coded chances in all, misses counted, and the share in
 *                    which the behaviour showed
 *   P3 contexts      distinct task contexts in which it showed
 *   P4 span          first to last coded chance, in the gym's calendar days
 *                    (lib/gymTime.ts); evidence older than the bar's currency
 *                    window is not current and not counted
 *   P5 observers     coaches who saw it -- at least one reading in which it
 *                    showed (report P5, "seen by one coach only") -- each with
 *                    enough sessions, agreeing, where the tier says so; or, in
 *                    their place, a share of the sessions double-coded by a
 *                    calibrated pair
 *   P6 lapse         the latest coded chances all missed: the tier lapses
 *
 * NOT UNTIL CALIBRATED (pick 3; Overwatch Q1 A on the PATTERN-1 plan,
 * PunxsyProminence/ppbf-platform#2082). A person's reading counts only when it
 * names a coach who is in a pair that has met the calibration bar on this
 * behaviour (inference/reliability.ts assessPairCalibration), and counting
 * coaches who coded one attempt together count on it only as a calibrated pair
 * (the ruling's "pair"). Every other person's reading is UNVERIFIED: returned,
 * and counted apart, so a coach can see it, and kept out of every tier count.
 * Calibration is per behaviour, per coach pair (report section 4), so it is
 * judged on the gym's whole record of this behaviour -- every athlete -- which
 * the caller passes as `calibrationReadings`. With no ratified calibration bar
 * no coach is calibrated, nothing counts, and the evaluation says so. One
 * calibrated coach can carry the emerging tier alone; it says "single
 * observer" when that is all there is.
 *
 * A READING THAT DOES NOT COUNT CHANGES NO COUNT. Only counting readings are
 * counted: an unverified reading, or a model's, cannot remove a counting
 * reading, by agreeing with it or by disputing it. Otherwise a reading that
 * counts toward no tier (Q1 A; for a model, types.ts InterpretationOrigin)
 * could lift one, by taking a calibrated coach's misses out of the share.
 *
 * DISPUTES (Overwatch Q4 A, #2082). An attempt the counting readings read
 * both ways -- one coach both ways, or two calibrated coaches -- counts for
 * neither side: it is left out of every count and listed for a person to look
 * at, and the tiers stand on the remaining attempts. Where only a reading that
 * does not count read an attempt the other way, the counts keep the attempt
 * as the counting readings read it, and the attempt is listed apart for a
 * person. Film contradicting a person's reading -- counting or not, whatever
 * the reading was sourced from -- still withholds every tier until a person
 * looks. Whose fault it was (attribution) is reported over the counted
 * attempts, not thresholded -- the approved bar sets no number for it, and
 * none is invented here.
 *
 * Nothing here decides anything: like the rest of this directory it returns
 * the standing and the reasons, and a coach decides what to do with it.
 */

import { gymDayIso } from '../../../lib/gymTime';
import type {
  ObserverCalibrationBar,
  PatternFormationBar,
  PatternTier,
  PatternTierBar,
} from '../learningPolicies';
import { collapseToEpisodes, episodeKeyOf, type EpisodeCollapse } from './episodes';
import { admitObservations, detectVideoContradiction, summarizeAttribution } from './evidence';
import { assessPairCalibration, pairKey, type PairCalibration } from './inference/reliability';
import type { AttributionSummary, BehaviourObservation, PatternReasonCode } from './types';

const TIERS: readonly PatternTier[] = ['emerging', 'pattern', 'established'];
const MILLISECONDS_PER_DAY = 86_400_000;

export type TierShortfall =
  | 'sessions'
  | 'coded_chances'
  | 'share'
  | 'contexts'
  | 'span'
  | 'observers'
  | 'lapsed';

export interface TierStanding {
  readonly met: boolean;
  /**
   * What this tier still needs, in the bar's own terms; empty when every
   * number is met. A withheld tier keeps its shortfalls, and
   * `PatternTierEvaluation.withheld` says why it is not met.
   */
  readonly shortfalls: readonly TierShortfall[];
}

export interface TierCounts {
  readonly sessions: number;
  readonly codedChances: number;
  readonly occurrences: number;
  readonly share: number | null;
  readonly contexts: number;
  /** Whole gym calendar days from the first coded chance to the last. */
  readonly spanDays: number | null;
  readonly coaches: number;
  readonly doubleCodedShare: number | null;
  /** Latest coded chances in a row, newest backwards, in which it did not show. */
  readonly trailingMisses: number;
}

export interface PatternTierEvaluation {
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
  /** The highest tier met, or null. */
  readonly tier: PatternTier | null;
  readonly standings: Readonly<Record<PatternTier, TierStanding>>;
  readonly counts: TierCounts;
  /** Film contradicting a coach: withholds every tier until a person looks. */
  readonly withheld: readonly PatternReasonCode[];
  /** Attempts the counting readings read both ways: left out of every count; every reading of them, for a person to look at. */
  readonly disputed: Readonly<{ attempts: number; observationIds: readonly string[] }>;
  /**
   * Attempts a person coded that only readings which do not count (an
   * unverified person's, or a model's) read the other way: counted as the
   * counting readings read them, if any; every reading of them, for a person
   * to look at. A reading can be in this list or `disputed` and also unverified.
   */
  readonly uncountedDissent: Readonly<{ attempts: number; observationIds: readonly string[] }>;
  /** Only one coach saw it. */
  readonly singleObserver: boolean;
  /** False when the gym has no ratified calibration bar: no coach is calibrated, so nothing counts. */
  readonly calibrationBarInForce: boolean;
  /** People's readings naming no calibrated coach, or coded together by coaches who are no calibrated pair: shown, not counted. */
  readonly unverifiedObservationIds: readonly string[];
  /** The attempts the unverified readings alone make, less those they read both ways, and how many of them showed it. */
  readonly unverifiedCounts: Readonly<{ codedChances: number; occurrences: number }>;
  readonly pairCalibrations: readonly PairCalibration[];
  readonly attribution: AttributionSummary;
  readonly asOf: string;
  /** Always true; nothing in this directory sets it false. */
  readonly humanReviewRequired: true;
}

export interface EvaluatePatternTiersInput {
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
  readonly observations: readonly BehaviourObservation[];
  /**
   * The gym's readings of this behaviour, EVERY athlete's, for judging coach
   * pairs. Each is admitted under its own athlete's scope; other gyms' and
   * other behaviours' readings are not.
   */
  readonly calibrationReadings: readonly BehaviourObservation[];
  readonly bar: PatternFormationBar;
  /** The gym's ratified calibration bar. None ratified: no pair is calibrated (3A). */
  readonly calibration: Pick<ObserverCalibrationBar, 'minimumAgreement' | 'minimumKappa' | 'minimumPairedJudgments'> | null;
  readonly asOf: string;
}

/** The gym's calendar date of an instant, as a whole day number. */
function gymDayNumber(instant: string): number {
  const day = gymDayIso(instant);
  return day === null ? Number.NaN : Date.parse(`${day}T00:00:00.000Z`) / MILLISECONDS_PER_DAY;
}

function observersOf(readings: readonly BehaviourObservation[]): string[] {
  return [...new Set(readings
    .filter((reading) => reading.interpretation === 'human_observed')
    .map((reading) => reading.observerAccountId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
}

function pairsCalibrated(observers: readonly string[], pairs: ReadonlyMap<string, PairCalibration>): boolean {
  for (let i = 0; i < observers.length; i += 1) {
    for (let j = i + 1; j < observers.length; j += 1) {
      if (!pairs.get(pairKey(observers[i], observers[j]))?.calibrated) return false;
    }
  }
  return true;
}

/** Some `size` of these coaches with every pair among them calibrated: a third coach never undoes a calibrated pair. */
function hasCalibratedGroup(observers: readonly string[], size: number, pairs: ReadonlyMap<string, PairCalibration>): boolean {
  const extend = (start: number, chosen: readonly string[]): boolean => {
    if (chosen.length >= size) return true;
    for (let index = start; index < observers.length; index += 1) {
      const next = observers[index];
      if (chosen.every((other) => pairs.get(pairKey(other, next))?.calibrated) && extend(index + 1, [...chosen, next])) {
        return true;
      }
    }
    return false;
  };
  return extend(0, []);
}

/** P1: a coded chance is an attempt a person scored; film or a model alone is none. Oldest first. */
function codedChancesOf(collapse: EpisodeCollapse): BehaviourObservation[] {
  return collapse.episodes
    .filter((episode) => (collapse.readingsOf.get(episode.observationId) ?? [episode])
      .some((reading) => reading.interpretation === 'human_observed'))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function admitCalibrationReadings(input: EvaluatePatternTiersInput): BehaviourObservation[] {
  const byAthlete = new Map<string, BehaviourObservation[]>();
  for (const reading of input.calibrationReadings) {
    const rows = byAthlete.get(reading.athleteId) ?? [];
    rows.push(reading);
    byAthlete.set(reading.athleteId, rows);
  }
  const admitted: BehaviourObservation[] = [];
  for (const athleteId of [...byAthlete.keys()].sort()) {
    const scope = { organizationId: input.organizationId, athleteId, behaviourKey: input.behaviourKey };
    admitted.push(...admitObservations(scope, byAthlete.get(athleteId)!, input.asOf).admitted);
  }
  return admitted;
}

export function evaluatePatternTiers(input: EvaluatePatternTiersInput): PatternTierEvaluation {
  const asOfDay = gymDayNumber(input.asOf);
  if (!Number.isFinite(asOfDay)) throw new TypeError('evaluatePatternTiers requires a valid asOf timestamp.');
  const scope = { organizationId: input.organizationId, athleteId: input.athleteId, behaviourKey: input.behaviourKey };
  const { admitted } = admitObservations(scope, input.observations, input.asOf);

  // Calibration is judged on the pair's whole record for this behaviour,
  // every athlete and not only the current window: agreement earned last
  // season, or on another athlete, still counts.
  const calibration = input.calibration ?? null;
  const pairs = calibration
    ? assessPairCalibration(admitCalibrationReadings(input), calibration)
    : new Map<string, PairCalibration>();

  // P4 currency: older evidence is history, not the athlete now.
  const current = admitted.filter(
    (reading) => gymDayNumber(reading.observedAt) >= asOfDay - input.bar.currentWithinDays,
  );

  // Not until calibrated, reading by reading (a reading with no key is an
  // attempt of its own): a person's reading counts when it names a calibrated
  // coach, and counting coaches on one attempt count only as calibrated pairs.
  const calibratedCoaches = new Set([...pairs.values()].filter((pair) => pair.calibrated).flatMap((pair) => pair.observers));
  const isCalibratedCoach = (reading: BehaviourObservation) => reading.interpretation === 'human_observed'
    && typeof reading.observerAccountId === 'string' && calibratedCoaches.has(reading.observerAccountId);
  const attempts = new Map<string, BehaviourObservation[]>();
  for (const reading of current) {
    const attempt = episodeKeyOf(reading);
    attempts.set(attempt, [...(attempts.get(attempt) ?? []), reading]);
  }
  const unverified = new Set<string>();
  for (const readings of attempts.values()) {
    const together = pairsCalibrated(observersOf(readings.filter(isCalibratedCoach)), pairs);
    for (const reading of readings) {
      if (reading.interpretation === 'human_observed' && !(together && isCalibratedCoach(reading))) {
        unverified.add(reading.observationId);
      }
    }
  }
  const counting = current.filter((reading) => reading.interpretation === 'human_observed' && !unverified.has(reading.observationId));

  // Disputes among counting readings leave the attempt out; other dissent on
  // an attempt a person coded is listed and changes no count. Film against a
  // person's reading withholds: evidence.ts's rule, and a model's film
  // reading against a person's reading of any source.
  const leftOut = new Set(collapseToEpisodes(counting).disputedEpisodeKeys);
  const dissent = new Set(collapseToEpisodes(current).disputedEpisodeKeys.filter((key) => !leftOut.has(key)
    && attempts.get(key)!.some((reading) => reading.interpretation === 'human_observed')));
  const listed = (keys: ReadonlySet<string>) => Object.freeze({
    attempts: keys.size,
    observationIds: Object.freeze(current.filter((reading) => keys.has(episodeKeyOf(reading))).map((reading) => reading.observationId).sort()),
  });
  const filmContradictsAPerson = detectVideoContradiction(current) || [...attempts.values()].some((readings) => readings.some(
    (film) => film.source.type === 'computer_vision' && film.interpretation !== 'human_observed' && readings.some(
      (person) => person.interpretation === 'human_observed' && person.polarity !== film.polarity,
    ),
  ));
  const withheld: PatternReasonCode[] = filmContradictsAPerson ? ['VIDEO_CONTRADICTS_OBSERVER'] : [];
  const counted = counting.filter((reading) => !leftOut.has(episodeKeyOf(reading)));
  const collapse = collapseToEpisodes(counted);
  const shownOnly = codedChancesOf(collapseToEpisodes(current.filter((reading) => unverified.has(reading.observationId))));

  const readingsOf = (episode: BehaviourObservation) => collapse.readingsOf.get(episode.observationId) ?? [episode];
  const episodes = codedChancesOf(collapse);
  const occurrences = episodes.filter((episode) => episode.polarity === 'occurrence');
  const days = episodes.map((episode) => gymDayNumber(episode.observedAt));
  let trailingMisses = 0;
  for (let index = episodes.length - 1; index >= 0 && episodes[index].polarity === 'counterexample'; index -= 1) {
    trailingMisses += 1;
  }

  // P5: who saw it. Sessions per coach count every coded chance they read,
  // shown or not; a coach who only ever recorded misses did not see it.
  const sessionsByCoach = new Map<string, Set<string>>();
  const sawIt = new Set<string>();
  for (const reading of counted) {
    if (reading.interpretation !== 'human_observed' || !reading.observerAccountId) continue;
    const sessions = sessionsByCoach.get(reading.observerAccountId) ?? new Set<string>();
    sessions.add(reading.sessionId);
    sessionsByCoach.set(reading.observerAccountId, sessions);
    if (reading.polarity === 'occurrence') sawIt.add(reading.observerAccountId);
  }
  const coaches = [...sawIt].sort();
  const sessions = new Set(episodes.map((episode) => episode.sessionId));
  const doubleCodedSessions = new Set(episodes
    .filter((episode) => observersOf(readingsOf(episode)).length >= 2)
    .map((episode) => episode.sessionId));

  const counts: TierCounts = Object.freeze({
    sessions: sessions.size,
    codedChances: episodes.length,
    occurrences: occurrences.length,
    share: episodes.length === 0 ? null : occurrences.length / episodes.length,
    contexts: new Set(occurrences.map((episode) => episode.taskContextKey)).size,
    spanDays: days.length === 0 ? null : Math.max(...days) - Math.min(...days),
    coaches: coaches.length,
    doubleCodedShare: sessions.size === 0 ? null : doubleCodedSessions.size / sessions.size,
    trailingMisses,
  });

  const observersMet = (tier: PatternTierBar): boolean => {
    const rule = tier.observers;
    const qualifying = coaches.filter(
      (coach) => (sessionsByCoach.get(coach)?.size ?? 0) >= (rule.minimumSessionsPerCoach ?? 0),
    );
    const coachRoute = rule.coachesMustAgree
      ? hasCalibratedGroup(qualifying, rule.minimumCoaches, pairs)
      : qualifying.length >= rule.minimumCoaches;
    const doubleCodedRoute = rule.orDoubleCodedShare !== null
      && counts.doubleCodedShare !== null && counts.doubleCodedShare >= rule.orDoubleCodedShare;
    return coachRoute || doubleCodedRoute;
  };

  const standings = Object.fromEntries(TIERS.map((name) => {
    const tier = input.bar.tiers[name];
    const shortfalls: TierShortfall[] = [];
    if (counts.sessions < tier.minimumSessions) shortfalls.push('sessions');
    if (counts.codedChances < tier.minimumCodedChances) shortfalls.push('coded_chances');
    if (counts.share === null || counts.share < tier.minimumShare) shortfalls.push('share');
    if (counts.contexts < tier.minimumContexts) shortfalls.push('contexts');
    if (counts.spanDays === null || counts.spanDays < tier.minimumSpanDays) shortfalls.push('span');
    if (!observersMet(tier)) shortfalls.push('observers');
    if (counts.trailingMisses >= tier.lapseAfterMisses) shortfalls.push('lapsed');
    const standing: TierStanding = Object.freeze({
      met: shortfalls.length === 0 && withheld.length === 0,
      shortfalls: Object.freeze(shortfalls),
    });
    return [name, standing];
  })) as Record<PatternTier, TierStanding>;

  const tier = [...TIERS].reverse().find((name) => standings[name].met) ?? null;

  return Object.freeze({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
    tier,
    standings: Object.freeze(standings),
    counts,
    withheld: Object.freeze(withheld),
    disputed: listed(leftOut),
    uncountedDissent: listed(dissent),
    singleObserver: coaches.length === 1,
    calibrationBarInForce: calibration !== null,
    unverifiedObservationIds: Object.freeze([...unverified].sort()),
    unverifiedCounts: Object.freeze({
      codedChances: shownOnly.length,
      occurrences: shownOnly.filter((episode) => episode.polarity === 'occurrence').length,
    }),
    pairCalibrations: Object.freeze([...pairs.values()]),
    attribution: summarizeAttribution(collapse.episodes),
    asOf: input.asOf,
    humanReviewRequired: true as const,
  });
}
