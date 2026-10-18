/**
 * Turns a bag of observations into the evidence vector a promotion decision
 * reads. Pure, deterministic, and total: every function here returns a fully
 * populated summary for any input, including an empty one.
 *
 * Nothing in this file decides anything. It counts, groups, and reports
 * disagreement. `promotion.ts` is where a policy is applied to these numbers.
 * Keeping the two apart is what lets the same evidence be re-judged against a
 * revised bar without recomputing -- and lets a reviewer see the evidence that
 * produced an abstention rather than only the abstention.
 */

import type {
  AttributionSummary,
  AttributionTarget,
  BehaviourObservation,
  ContextDiversitySummary,
  CounterEvidenceSummary,
  FatigueContext,
  PatternEvidenceSummary,
  PatternObservationProvenance,
  PatternReasonCode,
  TaskConstraint,
} from './types';

const MILLISECONDS_PER_DAY = 86_400_000;

export const ATTRIBUTION_TARGETS: readonly AttributionTarget[] = Object.freeze([
  'athlete',
  'coach_cue',
  'task_design',
  'partner_role',
  'environment',
  'equipment',
  'unresolved',
]);

/**
 * Source types that constitute video corroboration.
 *
 * `computer_vision` is the Film Study path (see `shadowFilmStudy.ts`). A
 * coach's recollection of having watched film is a `coach_tag`, not video
 * corroboration -- the distinction is the whole point of the dimension.
 */
const VIDEO_SOURCE_TYPES: ReadonlySet<string> = new Set(['computer_vision']);

/** Source types that represent a person's own judgement rather than an instrument. */
const HUMAN_JUDGEMENT_SOURCE_TYPES: ReadonlySet<string> = new Set(['coach_tag', 'manual']);

export interface ObservationScope {
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
}

export interface ObservationAdmission {
  readonly admitted: readonly BehaviourObservation[];
  readonly excluded: readonly {
    readonly observationId: string;
    readonly reason: PatternReasonCode;
  }[];
}

function sortKey(observation: BehaviourObservation): string {
  return `${observation.observedAt}|${observation.observationId}`;
}

function scopeFailure(scope: ObservationScope, observation: BehaviourObservation): PatternReasonCode | null {
  if (observation.organizationId !== scope.organizationId) return 'ORGANIZATION_SCOPE_MISMATCH';
  if (observation.athleteId !== scope.athleteId) return 'ATHLETE_SCOPE_MISMATCH';
  if (observation.behaviourKey !== scope.behaviourKey) return 'BEHAVIOUR_KEY_MISMATCH';
  if (!Number.isFinite(Date.parse(observation.observedAt))) return 'INVALID_TIMESTAMP';
  return null;
}

/**
 * Groups readings by the attempt they are about: session, task and
 * opportunity key. A reading with no opportunity key has no group -- nothing
 * says which rep it scored, so it cannot be set against anyone else's.
 */
function groupByOpportunity(
  observations: readonly BehaviourObservation[],
): Map<string, BehaviourObservation[]> {
  const groups = new Map<string, BehaviourObservation[]>();
  for (const observation of observations) {
    const { opportunityKey } = observation;
    if (typeof opportunityKey !== 'string' || opportunityKey.length === 0) continue;
    const key = JSON.stringify([observation.sessionId, observation.taskContextKey, opportunityKey]);
    const group = groups.get(key);
    if (group) group.push(observation);
    else groups.set(key, [observation]);
  }
  return groups;
}

/**
 * Filters a candidate's observations down to those that may contribute
 * evidence, recording WHY each rejection happened.
 *
 * Rejections are reported rather than dropped because an evaluation that
 * abstained on two admitted observations, having silently discarded nine
 * out-of-scope ones, would be indistinguishable from one that only ever saw
 * two -- and a reviewer would have no way to notice a mis-keyed import.
 *
 * A superseded observation is excluded from evidence but kept in the
 * exclusion list: a coach revising their own call after film is a real,
 * auditable act, and erasing the original would hide the revision. Only a
 * record that is admissible in its own right can supersede: another
 * athlete's revision, a mis-keyed import or a failed capture has no standing
 * to remove evidence it was never part of.
 *
 * With `asOf`, records observed after that instant are left out entirely --
 * not listed as exclusions -- because at `asOf` they had not been made yet.
 * That is what keeps an evaluation reproducible: the same instant gives the
 * same answer however much later data the caller happens to pass, and a
 * revision recorded after `asOf` does not reach back to supersede at it.
 */
export function admitObservations(
  scope: ObservationScope,
  observations: readonly BehaviourObservation[],
  asOf?: string,
): ObservationAdmission {
  const admitted: BehaviourObservation[] = [];
  const excluded: { observationId: string; reason: PatternReasonCode }[] = [];

  let asOfMs = Number.POSITIVE_INFINITY;
  if (asOf !== undefined) {
    asOfMs = Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) {
      throw new TypeError('admitObservations requires asOf, when given, to be a valid timestamp.');
    }
  }

  const ordered = observations
    // An unreadable timestamp stays in so it is reported as INVALID_TIMESTAMP.
    .filter((observation) => !(Date.parse(observation.observedAt) > asOfMs))
    .sort((left, right) => sortKey(left).localeCompare(sortKey(right)));

  // First pass: which records may supersede. The same checks as below, so a
  // record the second pass rejects can never have suppressed anything.
  const supersededIds = new Set<string>();
  const standingIds = new Set<string>();
  for (const observation of ordered) {
    if (standingIds.has(observation.observationId)) continue;
    standingIds.add(observation.observationId);
    if (scopeFailure(scope, observation) !== null || observation.source.quality === 'failed') continue;
    const target = observation.supersedesObservationId;
    if (typeof target === 'string' && target.length > 0 && target !== observation.observationId) {
      supersededIds.add(target);
    }
  }

  const seenIds = new Set<string>();

  for (const observation of ordered) {
    if (seenIds.has(observation.observationId)) {
      excluded.push({ observationId: observation.observationId, reason: 'DUPLICATE_OBSERVATION_ID' });
      continue;
    }
    seenIds.add(observation.observationId);

    const failure = scopeFailure(scope, observation);
    if (failure !== null) {
      excluded.push({ observationId: observation.observationId, reason: failure });
      continue;
    }
    if (supersededIds.has(observation.observationId)) {
      excluded.push({ observationId: observation.observationId, reason: 'SUPERSEDED_OBSERVATION' });
      continue;
    }
    // A failed capture is not weak evidence, it is absent evidence: the
    // instrument reported that it did not measure what it was pointed at.
    if (observation.source.quality === 'failed') {
      excluded.push({ observationId: observation.observationId, reason: 'SOURCE_QUALITY_FAIL' });
      continue;
    }

    admitted.push(observation);
  }

  return Object.freeze({
    admitted: Object.freeze(admitted),
    excluded: Object.freeze(excluded),
  });
}

function occurrencesOf(
  observations: readonly BehaviourObservation[],
): readonly BehaviourObservation[] {
  return observations.filter((observation) => observation.polarity === 'occurrence');
}

function counterexamplesOf(
  observations: readonly BehaviourObservation[],
): readonly BehaviourObservation[] {
  return observations.filter((observation) => observation.polarity === 'counterexample');
}

function distinct<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

export function summarizeEvidence(
  observations: readonly BehaviourObservation[],
): PatternEvidenceSummary {
  const occurrences = occurrencesOf(observations);
  const counterexamples = counterexamplesOf(observations);

  const timestamps = observations
    .map((observation) => Date.parse(observation.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const firstMs = timestamps[0] ?? null;
  const lastMs = timestamps[timestamps.length - 1] ?? null;

  return Object.freeze({
    occurrenceCount: occurrences.length,
    counterexampleCount: counterexamples.length,
    totalObservations: observations.length,

    // Diversity dimensions count OCCURRENCES only. A counterexample seen in a
    // fourth drill does not make the claimed behaviour four-drill evidenced;
    // it is evidence against, and is summarised separately.
    distinctSessions: distinct(occurrences.map((item) => item.sessionId)).length,
    distinctTaskContexts: distinct(occurrences.map((item) => item.taskContextKey)).length,
    distinctObservers: distinct(
      occurrences
        .map((item) => item.observerAccountId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ).length,
    distinctSourceTypes: distinct(occurrences.map((item) => item.source.type)).length,

    taskConstraints: Object.freeze(distinct(occurrences.map((item) => item.taskConstraint)) as TaskConstraint[]),
    fatigueContexts: Object.freeze(distinct(occurrences.map((item) => item.fatigueContext)) as FatigueContext[]),

    humanObservedCount: occurrences.filter((item) => item.interpretation === 'human_observed').length,
    aiProposedCount: occurrences.filter((item) => item.interpretation === 'ai_proposed').length,
    videoCorroboratedCount: occurrences.filter((item) => VIDEO_SOURCE_TYPES.has(item.source.type)).length,

    firstObservedAt: firstMs == null ? null : new Date(firstMs).toISOString(),
    lastObservedAt: lastMs == null ? null : new Date(lastMs).toISOString(),
    observedSpanDays:
      firstMs == null || lastMs == null ? null : (lastMs - firstMs) / MILLISECONDS_PER_DAY,
  });
}

export function summarizeContextDiversity(
  observations: readonly BehaviourObservation[],
): ContextDiversitySummary {
  const occurrences = occurrencesOf(observations);
  const constraints = new Set(occurrences.map((item) => item.taskConstraint));
  const fatigueValues = occurrences.map((item) => item.fatigueContext);
  const knownFatigue = fatigueValues.filter((value) => value !== 'unknown');
  const distinctKnownFatigue = new Set(knownFatigue);

  // Confinement requires that every occurrence carries a KNOWN fatigue state
  // and they all agree. If any observation left fatigue unrecorded, the
  // honest answer is that we do not know whether it is confined -- not that
  // it is confined to whatever the recorded ones happen to say.
  const fatigueConfined =
    occurrences.length > 0
    && knownFatigue.length === occurrences.length
    && distinctKnownFatigue.size === 1;

  const hasControlledContext = constraints.has('controlled');
  // A constrained-live task counts as live exposure for span purposes: it is
  // an opponent responding, which is the property `controlled` lacks.
  const hasLiveContext = constraints.has('live') || constraints.has('constrained_live');

  return Object.freeze({
    distinctTaskContexts: distinct(occurrences.map((item) => item.taskContextKey)).length,
    distinctSessions: distinct(occurrences.map((item) => item.sessionId)).length,
    hasControlledContext,
    hasLiveContext,
    spansConstraintTypes: hasControlledContext && hasLiveContext,
    distinctFatigueContexts: new Set(fatigueValues).size,
    fatigueConfined,
    confinedFatigueContext: fatigueConfined ? [...distinctKnownFatigue][0] : null,
  });
}

export function summarizeAttribution(
  observations: readonly BehaviourObservation[],
): AttributionSummary {
  const occurrences = occurrencesOf(observations);
  const tally = Object.fromEntries(
    ATTRIBUTION_TARGETS.map((target) => [target, 0]),
  ) as Record<AttributionTarget, number>;

  for (const observation of occurrences) {
    tally[observation.attribution.target] += 1;
  }

  const ranked = ATTRIBUTION_TARGETS
    .map((target) => ({ target, count: tally[target] }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);

  // A tie has no leader. Reporting the alphabetically-first target as
  // "leading" would invent a winner out of a genuine split.
  const leading =
    ranked.length > 0 && (ranked.length === 1 || ranked[0].count > ranked[1].count)
      ? ranked[0].target
      : null;

  const nonAthleteImplicated = ATTRIBUTION_TARGETS
    .filter((target) => target !== 'athlete' && target !== 'unresolved')
    .some((target) => tally[target] > 0);

  return Object.freeze({
    tally: Object.freeze(tally),
    leading,
    athleteShare: occurrences.length === 0 ? null : tally.athlete / occurrences.length,
    nonAthleteImplicated,
    uncertainCount: occurrences.filter((item) => item.attribution.certainty === 'uncertain').length,
  });
}

export function summarizeCounterEvidence(
  observations: readonly BehaviourObservation[],
): CounterEvidenceSummary {
  const occurrences = occurrencesOf(observations);
  const counterexamples = counterexamplesOf(observations);

  const counterTimestamps = counterexamples
    .map((item) => Date.parse(item.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const mostRecentCounterMs = counterTimestamps[counterTimestamps.length - 1] ?? null;
  const mostRecentOccurrenceMs = occurrences
    .map((item) => Date.parse(item.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
    .at(-1) ?? null;

  return Object.freeze({
    count: counterexamples.length,
    distinctSessions: distinct(counterexamples.map((item) => item.sessionId)).length,
    distinctTaskContexts: distinct(counterexamples.map((item) => item.taskContextKey)).length,
    mostRecentAt: mostRecentCounterMs == null ? null : new Date(mostRecentCounterMs).toISOString(),
    ratioToOccurrences: occurrences.length === 0 ? null : counterexamples.length / occurrences.length,
    isMostRecentEvidence:
      mostRecentCounterMs != null
      && (mostRecentOccurrenceMs == null || mostRecentCounterMs > mostRecentOccurrenceMs),
  });
}

/**
 * Two observers, same attempt, opposite polarity.
 *
 * This is the "two coaches disagree" signal. It is deliberately scoped to one
 * attempt -- shared session, task AND opportunity key: the same behaviour
 * occurring in one drill and not in another is ordinary variation, and so is
 * it occurring on rep 1 and not on rep 4. Disagreement means two people
 * watched the same thing and reported different events.
 */
export function detectObserverDisagreement(
  observations: readonly BehaviourObservation[],
): boolean {
  const groups = groupByOpportunity(observations.filter((observation) => observation.observerAccountId));

  for (const group of groups.values()) {
    const occurrenceObservers = new Set(
      group.filter((item) => item.polarity === 'occurrence').map((item) => item.observerAccountId),
    );
    const counterObservers = new Set(
      group.filter((item) => item.polarity === 'counterexample').map((item) => item.observerAccountId),
    );
    for (const observer of counterObservers) {
      for (const other of occurrenceObservers) {
        if (observer !== other) return true;
      }
    }
  }
  return false;
}

/**
 * Video and a person disagree about the same attempt (session, task and
 * opportunity key, as for observer disagreement).
 *
 * Note what this does NOT do: it does not rule for the video. Film is a
 * better record of what physically happened and a worse record of what the
 * coach meant by the behaviour they named, so a contradiction is a reason to
 * stop and have a human look, not a reason to overwrite the coach. The
 * resulting state is CONTESTED, which is an abstention.
 */
export function detectVideoContradiction(
  observations: readonly BehaviourObservation[],
): boolean {
  const groups = groupByOpportunity(observations);

  for (const group of groups.values()) {
    const video = group.filter((item) => VIDEO_SOURCE_TYPES.has(item.source.type));
    const human = group.filter((item) => HUMAN_JUDGEMENT_SOURCE_TYPES.has(item.source.type));
    if (video.length === 0 || human.length === 0) continue;

    const videoPolarities = new Set(video.map((item) => item.polarity));
    const humanPolarities = new Set(human.map((item) => item.polarity));
    for (const polarity of videoPolarities) {
      for (const otherPolarity of humanPolarities) {
        if (polarity !== otherPolarity) return true;
      }
    }
  }
  return false;
}

export function toProvenance(
  observations: readonly BehaviourObservation[],
): readonly PatternObservationProvenance[] {
  return Object.freeze(
    observations.map((observation) => Object.freeze({
      observationId: observation.observationId,
      sessionId: observation.sessionId,
      taskContextKey: observation.taskContextKey,
      taskConstraint: observation.taskConstraint,
      fatigueContext: observation.fatigueContext,
      observedAt: observation.observedAt,
      opportunityKey: observation.opportunityKey ?? null,
      sourceType: observation.source.type,
      sourceQuality: observation.source.quality,
      observerAccountId: observation.observerAccountId,
      interpretation: observation.interpretation,
      polarity: observation.polarity,
      attributionTarget: observation.attribution.target,
      attributionCertainty: observation.attribution.certainty,
    })),
  );
}

/**
 * Occurrences inside the policy's staleness horizon, relative to `asOf`:
 * no older than the horizon and no later than `asOf` itself.
 */
export function recentOccurrenceCount(
  observations: readonly BehaviourObservation[],
  asOf: string,
  staleAfterDays: number,
): number {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return 0;
  const horizonMs = asOfMs - (staleAfterDays * MILLISECONDS_PER_DAY);
  return occurrencesOf(observations).filter((observation) => {
    const observedMs = Date.parse(observation.observedAt);
    return Number.isFinite(observedMs) && observedMs >= horizonMs && observedMs <= asOfMs;
  }).length;
}
