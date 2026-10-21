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
 * NOT UNTIL CALIBRATED. An attempt coded by two people whose pair has not met
 * the calibration bar (inference/reliability.ts assessPairCalibration) is
 * UNVERIFIED: returned, so a coach can see it, and kept out of every count.
 * Calibration is per behaviour, per coach pair (report section 4), so it is
 * judged on the gym's whole record of this behaviour -- every athlete -- which
 * the caller passes as `calibrationReadings`. One coach's own readings are not
 * a pair and still count; the emerging tier says "single observer" when that
 * is all there is.
 *
 * DISPUTES WITHHOLD EVERY TIER. Attempts read both ways, two observers
 * scoring the same attempt differently, or film contradicting a coach: the
 * readers do not agree on what happened, so no tier is claimed until a person
 * looks. Disputes are read from every current reading, the unverified ones
 * included: two coaches not yet calibrated who disagree still disagree.
 * Whose fault it was (attribution) is reported, not thresholded -- the
 * approved bar sets no number for it, and none is invented here.
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
import { collapseToEpisodes, episodeKeyOf } from './episodes';
import { admitObservations, detectObserverDisagreement, detectVideoContradiction, summarizeAttribution } from './evidence';
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
  /** Disputes that withhold every tier until a person looks. */
  readonly withheld: readonly PatternReasonCode[];
  /** Only one coach saw it. */
  readonly singleObserver: boolean;
  /** Readings of attempts coded by an uncalibrated pair: shown, not counted. */
  readonly unverifiedObservationIds: readonly string[];
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
  const pairs = input.calibration
    ? assessPairCalibration(admitCalibrationReadings(input), input.calibration)
    : new Map<string, PairCalibration>();

  // P4 currency: older evidence is history, not the athlete now.
  const current = admitted.filter(
    (reading) => gymDayNumber(reading.observedAt) >= asOfDay - input.bar.currentWithinDays,
  );

  // Not until calibrated: an attempt two people coded counts only when their
  // pair is calibrated. Its readings are returned, not counted, otherwise.
  const unverified = new Set<string>();
  const attempts = new Map<string, BehaviourObservation[]>();
  for (const reading of current) {
    if (typeof reading.opportunityKey !== 'string' || reading.opportunityKey.length === 0) continue;
    const attempt = episodeKeyOf(reading);
    attempts.set(attempt, [...(attempts.get(attempt) ?? []), reading]);
  }
  for (const readings of attempts.values()) {
    const observers = observersOf(readings);
    if (observers.length >= 2 && !pairsCalibrated(observers, pairs)) {
      for (const reading of readings) unverified.add(reading.observationId);
    }
  }
  const verified = current.filter((reading) => !unverified.has(reading.observationId));
  const collapse = collapseToEpisodes(verified);

  const withheld: PatternReasonCode[] = [];
  if (collapseToEpisodes(current).disputedEpisodeKeys.length > 0) withheld.push('ATTEMPT_DISPUTED');
  if (detectObserverDisagreement(current)) withheld.push('OBSERVER_DISAGREEMENT');
  if (detectVideoContradiction(current)) withheld.push('VIDEO_CONTRADICTS_OBSERVER');

  // P1: a coded chance is an attempt a coach scored.
  const readingsOf = (episode: BehaviourObservation) => collapse.readingsOf.get(episode.observationId) ?? [episode];
  const episodes = collapse.episodes
    .filter((episode) => readingsOf(episode).some((reading) => reading.interpretation === 'human_observed'))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
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
  for (const reading of verified) {
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
    singleObserver: coaches.length === 1,
    unverifiedObservationIds: Object.freeze([...unverified].sort()),
    pairCalibrations: Object.freeze([...pairs.values()]),
    attribution: summarizeAttribution(collapse.episodes),
    asOf: input.asOf,
    humanReviewRequired: true as const,
  });
}
