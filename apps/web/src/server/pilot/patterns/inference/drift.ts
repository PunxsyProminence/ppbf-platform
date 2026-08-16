/**
 * Stack v1.1 §2.5 -- EWMA and CUSUM over a per-athlete, per-session series.
 *
 * THE QUESTION: is this pattern still the athlete's pattern? A behaviour that
 * was fair last season and has faded since is not still true, and an overlay
 * nobody re-examined is how a kid gets coached against a version of themselves
 * they have already outgrown. `#337` retires a pattern when recent evidence
 * stops arriving; this adds the harder case -- evidence still arriving, at a
 * rate that has shifted.
 *
 * NO NEW BASELINE STORE. The EWMA is `formulas/primitives.ts`'s `ewma`,
 * imported, not reimplemented: the numeric ladder already owns that primitive
 * and a second copy would be a second thing to keep correct. The series here
 * is derived from observations the caller already admitted, and nothing is
 * persisted.
 *
 * CUSUM AGAINST THE SERIES' OWN MEAN. There is no external target rate to
 * chart against -- inventing one would be exactly the unapproved threshold the
 * review bar forbids -- so the reference is the athlete's own average over the
 * window, which is the standard no-known-target formulation. Slack and
 * decision interval are injected policy.
 *
 * A DETECTED SHIFT IS NOT A VERDICT. `shiftDown` feeds pattern-fade as a
 * reason code and can only ever make promotion harder. Nothing here promotes.
 */

import { ewma } from '../../formulas/primitives';
import type { BehaviourObservation, PatternReasonCode } from '../types';
import { assertPatternInferencePolicy, type PatternInferencePolicy } from './policy';

export interface SessionRatePoint {
  readonly sessionId: string;
  readonly observedAt: string;
  readonly trials: number;
  readonly occurrences: number;
  readonly rate: number;
}

export interface DriftAssessment {
  readonly points: readonly SessionRatePoint[];
  readonly referenceRate: number | null;
  readonly ewmaSeries: readonly number[];
  readonly ewmaLatest: number | null;
  readonly cusumHigh: number;
  readonly cusumLow: number;
  readonly shiftUp: boolean;
  readonly shiftDown: boolean;
  /** Sustained downward shift: the behaviour is receding. */
  readonly fading: boolean;
  readonly reasons: readonly PatternReasonCode[];
  /** Set when there is not enough history to chart. Not a failure. */
  readonly unavailableReason: 'INSUFFICIENT_HISTORY' | null;
}

/**
 * Collapses observations into one point per session, ordered by time.
 *
 * A session is the unit because it is the unit everywhere else on this ladder:
 * three occurrences inside one session are one session's worth of evidence,
 * and charting them as three points would let a single bad round look like a
 * trend.
 */
export function buildSessionRateSeries(
  observations: readonly BehaviourObservation[],
): readonly SessionRatePoint[] {
  const groups = new Map<string, BehaviourObservation[]>();
  for (const observation of observations) {
    const group = groups.get(observation.sessionId);
    if (group) group.push(observation);
    else groups.set(observation.sessionId, [observation]);
  }

  const points: SessionRatePoint[] = [];
  for (const [sessionId, members] of groups) {
    const trials = members.length;
    const occurrences = members.filter((item) => item.polarity === 'occurrence').length;
    const earliest = members
      .map((item) => Date.parse(item.observedAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (earliest == null || trials === 0) continue;
    points.push({
      sessionId,
      observedAt: new Date(earliest).toISOString(),
      trials,
      occurrences,
      rate: occurrences / trials,
    });
  }

  return Object.freeze(
    points.sort(
      (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
        || left.sessionId.localeCompare(right.sessionId),
    ),
  );
}

export function assessDrift(
  observations: readonly BehaviourObservation[],
  policy: PatternInferencePolicy,
): DriftAssessment {
  assertPatternInferencePolicy(policy);

  const points = buildSessionRateSeries(observations);
  const empty = {
    points,
    referenceRate: null,
    ewmaSeries: Object.freeze([]),
    ewmaLatest: null,
    cusumHigh: 0,
    cusumLow: 0,
    shiftUp: false,
    shiftDown: false,
    fading: false,
    reasons: Object.freeze([]),
  } as const;

  if (points.length < policy.drift.minimumHistorySessions) {
    // Not chartable yet, which is different from charted-and-flat. Saying so
    // keeps a young pattern from reading as a stable one.
    return Object.freeze({ ...empty, unavailableReason: 'INSUFFICIENT_HISTORY' as const });
  }

  const rates = points.map((point) => point.rate);
  const smoothed = ewma(rates, policy.drift.ewmaLambda);
  if (!smoothed.ok) {
    return Object.freeze({ ...empty, unavailableReason: 'INSUFFICIENT_HISTORY' as const });
  }

  const referenceRate = rates.reduce((sum, value) => sum + value, 0) / rates.length;
  const { cusumSlack, cusumThreshold } = policy.drift;

  let cusumHigh = 0;
  let cusumLow = 0;
  for (const rate of rates) {
    cusumHigh = Math.max(0, cusumHigh + (rate - referenceRate - cusumSlack));
    cusumLow = Math.max(0, cusumLow + (referenceRate - rate - cusumSlack));
  }

  // The flags read the chart's TERMINAL state, not whether it ever crossed.
  //
  // Charting against the series' own mean means an emerging behaviour sits
  // below that mean for its early sessions, so an "ever crossed" reading would
  // report a pattern that is plainly arriving as one that is fading -- and
  // fading is the flag that retires an athlete's overlay. The terminal value
  // answers the question actually being asked: is it receding *now*. A chart
  // that dipped and recovered has recovered.
  const shiftUp = cusumHigh > cusumThreshold;
  const shiftDown = cusumLow > cusumThreshold;

  const reasons: PatternReasonCode[] = [];
  if (shiftDown) reasons.push('PATTERN_FADING');

  return Object.freeze({
    points,
    referenceRate,
    ewmaSeries: Object.freeze([...smoothed.series]),
    ewmaLatest: smoothed.value,
    cusumHigh,
    cusumLow,
    shiftUp,
    shiftDown,
    fading: shiftDown,
    reasons: Object.freeze(reasons),
    unavailableReason: null,
  });
}
