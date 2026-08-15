/**
 * Observer reliability: is this a fact about the athlete, or about who was
 * watching?
 *
 * THE GAP THIS CLOSES. The ladder already refuses a pattern seen by only one
 * observer, and flags `OBSERVER_DISAGREEMENT` when two coaches tag the same
 * session differently. Both are binary. Neither can tell the difference
 * between two coaches who agree nineteen times out of twenty and disagree
 * once, and two coaches who are essentially flipping coins -- and those are
 * completely different claims about whether the behaviour is real.
 *
 * Requiring two observers buys nothing if the two do not agree with each
 * other. Multiple observers is a proxy for measurement validity; agreement is
 * the thing itself. Without this, an "established" pattern can be an artifact
 * of one coach's tagging habits that a second coach happened to be present
 * for.
 *
 * WHY CHANCE-CORRECTED. Raw percent agreement is inflated by base rates: if a
 * behaviour is tagged as occurring 90% of the time, two coaches who both
 * mostly say "occurrence" will agree ~82% of the time by accident alone.
 * Reporting that as reliability would credit the base rate to the coaches.
 * Fleiss' kappa subtracts the agreement expected by chance.
 *
 * THE DEGENERATE CASE IS NOT PERFECT RELIABILITY. When every rating in the
 * window falls in one category, chance agreement is 1, kappa is 0/0, and there
 * is genuinely no information about whether these observers can distinguish
 * anything. That reports as `degenerate_no_variance` -- never as agreement.
 * Returning 1.0 there would let the least informative possible data produce
 * the strongest possible reliability claim.
 */

import type { BehaviourObservation, ObservationPolarity } from '../types';

export type ReliabilityVerdict =
  | 'reliable'
  | 'below_policy'
  | 'insufficient_overlap'
  | 'degenerate_no_variance';

export interface ObserverReliabilityPolicy {
  readonly policyVersion: string;
  readonly ratifiedByAccountId: string;
  readonly ratifiedAt: string;
  /** Sessions rated by two or more observers required before kappa is computed. */
  readonly minimumCoRatedItems: number;
  /** Chance-corrected agreement at or above which measurement is trusted. */
  readonly minimumKappa: number;
  /**
   * Share of co-rated items on which one observer may differ from the rest
   * before they are named as systematically out of step.
   */
  readonly maximumObserverDeviation: number;
}

export function assertObserverReliabilityPolicy(policy: ObserverReliabilityPolicy): void {
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('RELIABILITY_POLICY_MISSING: an observer reliability policy is required.');
  }
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion.trim()) {
    throw new TypeError('Observer reliability policy requires a policyVersion.');
  }
  if (typeof policy.ratifiedByAccountId !== 'string' || !policy.ratifiedByAccountId.trim()) {
    throw new TypeError(
      'Observer reliability policy requires ratifiedByAccountId: a measurement bar must be attributable to a person.',
    );
  }
  if (typeof policy.ratifiedAt !== 'string' || !Number.isFinite(Date.parse(policy.ratifiedAt))) {
    throw new TypeError('Observer reliability policy requires a valid ratifiedAt timestamp.');
  }
  if (!Number.isInteger(policy.minimumCoRatedItems) || policy.minimumCoRatedItems < 2) {
    throw new TypeError(
      'minimumCoRatedItems must be at least 2: agreement on a single session is a coincidence, not a measurement.',
    );
  }
  if (!Number.isFinite(policy.minimumKappa) || policy.minimumKappa <= 0 || policy.minimumKappa >= 1) {
    throw new TypeError('minimumKappa must be strictly between 0 and 1.');
  }
  if (!Number.isFinite(policy.maximumObserverDeviation)
    || policy.maximumObserverDeviation <= 0
    || policy.maximumObserverDeviation >= 1) {
    throw new TypeError('maximumObserverDeviation must be strictly between 0 and 1.');
  }
}

const CATEGORIES: readonly ObservationPolarity[] = ['occurrence', 'counterexample'];

export interface CoRatedItem {
  readonly sessionId: string;
  readonly raterCount: number;
  readonly categoryCounts: Readonly<Record<ObservationPolarity, number>>;
  /** Proportion of rater pairs on this item that agreed. */
  readonly agreement: number;
}

export interface ObserverDeviation {
  readonly observerAccountId: string;
  readonly coRatedItems: number;
  /** Items where this observer differed from the majority of the others. */
  readonly deviantItems: number;
  readonly deviationRate: number;
  readonly systematicallyDeviant: boolean;
}

export interface ObserverReliabilityAssessment {
  readonly coRatedItems: readonly CoRatedItem[];
  readonly observedAgreement: number | null;
  readonly chanceAgreement: number | null;
  /** Fleiss' kappa. Null when undefined (degenerate or too little overlap). */
  readonly kappa: number | null;
  readonly observerDeviations: readonly ObserverDeviation[];
  readonly verdict: ReliabilityVerdict;
  readonly reasons: readonly string[];
  readonly policyVersion: string;
}

/**
 * Groups observations into items rated by two or more observers.
 *
 * An item is one session's verdict from one observer. Where an observer
 * recorded several observations in a session, their MODAL polarity is taken as
 * their rating for it -- a coach who tagged four occurrences and one
 * counterexample in a round rated that round "occurrence". Counting each
 * observation separately would let the most prolific tagger dominate the
 * agreement statistic.
 */
function buildCoRatedItems(
  observations: readonly BehaviourObservation[],
): { items: CoRatedItem[]; ratingsBySession: Map<string, Map<string, ObservationPolarity>> } {
  const bySession = new Map<string, Map<string, BehaviourObservation[]>>();
  for (const observation of observations) {
    // A machine-captured observation has no observerAccountId and is not a
    // rater here. Inter-rater agreement is a claim about whether the PEOPLE
    // doing the tagging see the same thing; folding a detector into that
    // average would let the instrument vouch for its own operators, and the
    // deviation report names accounts, which a camera does not have.
    if (observation.observerAccountId === null) continue;
    let observers = bySession.get(observation.sessionId);
    if (!observers) {
      observers = new Map();
      bySession.set(observation.sessionId, observers);
    }
    const existing = observers.get(observation.observerAccountId);
    if (existing) existing.push(observation);
    else observers.set(observation.observerAccountId, [observation]);
  }

  const items: CoRatedItem[] = [];
  const ratingsBySession = new Map<string, Map<string, ObservationPolarity>>();

  for (const sessionId of [...bySession.keys()].sort()) {
    const observers = bySession.get(sessionId)!;
    if (observers.size < 2) continue;

    const ratings = new Map<string, ObservationPolarity>();
    for (const [observerAccountId, theirs] of observers) {
      const occurrences = theirs.filter((item) => item.polarity === 'occurrence').length;
      const counterexamples = theirs.length - occurrences;
      // A tie within one observer's own tagging is not a verdict; skip rather
      // than break it arbitrarily.
      if (occurrences === counterexamples) continue;
      ratings.set(observerAccountId, occurrences > counterexamples ? 'occurrence' : 'counterexample');
    }
    if (ratings.size < 2) continue;

    const categoryCounts = { occurrence: 0, counterexample: 0 } as Record<ObservationPolarity, number>;
    for (const polarity of ratings.values()) categoryCounts[polarity] += 1;

    const raterCount = ratings.size;
    const agreeingPairs = CATEGORIES.reduce(
      (sum, category) => sum + ((categoryCounts[category] * (categoryCounts[category] - 1)) / 2),
      0,
    );
    const totalPairs = (raterCount * (raterCount - 1)) / 2;

    items.push(Object.freeze({
      sessionId,
      raterCount,
      categoryCounts: Object.freeze({ ...categoryCounts }),
      agreement: totalPairs === 0 ? 0 : agreeingPairs / totalPairs,
    }));
    ratingsBySession.set(sessionId, ratings);
  }

  return { items, ratingsBySession };
}

export function assessObserverReliability(
  observations: readonly BehaviourObservation[],
  policy: ObserverReliabilityPolicy,
): ObserverReliabilityAssessment {
  assertObserverReliabilityPolicy(policy);

  const { items, ratingsBySession } = buildCoRatedItems(observations);
  const reasons: string[] = [];

  const empty = {
    coRatedItems: Object.freeze(items),
    observedAgreement: null,
    chanceAgreement: null,
    kappa: null,
    observerDeviations: Object.freeze([]),
    policyVersion: policy.policyVersion,
  } as const;

  if (items.length < policy.minimumCoRatedItems) {
    // Not enough sessions were watched by more than one person to say whether
    // these coaches see the same thing. Different from "they disagree".
    reasons.push('RELIABILITY_INSUFFICIENT_OVERLAP');
    return Object.freeze({
      ...empty,
      verdict: 'insufficient_overlap' as const,
      reasons: Object.freeze(reasons),
    });
  }

  // Fleiss' kappa, generalized to unequal raters per item.
  const observedAgreement = items.reduce((sum, item) => sum + item.agreement, 0) / items.length;

  const totalRatings = items.reduce((sum, item) => sum + item.raterCount, 0);
  const chanceAgreement = CATEGORIES.reduce((sum, category) => {
    const share = items.reduce((count, item) => count + item.categoryCounts[category], 0) / totalRatings;
    return sum + (share * share);
  }, 0);

  // 1 - chance == 0 means every rating fell in one category. Kappa is 0/0.
  const degenerate = 1 - chanceAgreement <= Number.EPSILON;
  if (degenerate) {
    reasons.push('RELIABILITY_NO_VARIANCE');
    return Object.freeze({
      ...empty,
      coRatedItems: Object.freeze(items),
      observedAgreement,
      chanceAgreement,
      verdict: 'degenerate_no_variance' as const,
      reasons: Object.freeze(reasons),
    });
  }

  const kappa = (observedAgreement - chanceAgreement) / (1 - chanceAgreement);

  // Per-observer: how often does this person differ from everyone else?
  const observerIds = new Set<string>();
  for (const ratings of ratingsBySession.values()) {
    for (const observerAccountId of ratings.keys()) observerIds.add(observerAccountId);
  }

  const observerDeviations: ObserverDeviation[] = [];
  for (const observerAccountId of [...observerIds].sort()) {
    let coRated = 0;
    let deviant = 0;
    for (const ratings of ratingsBySession.values()) {
      const own = ratings.get(observerAccountId);
      if (own === undefined) continue;
      const others = [...ratings.entries()]
        .filter(([id]) => id !== observerAccountId)
        .map(([, polarity]) => polarity);
      // A consensus needs at least two other people. With a single other
      // rater, a disagreement is symmetric -- neither party is identifiable as
      // the one out of step, and marking both would flag both coaches in a
      // two-coach gym every time they saw a round differently. Such items
      // still count toward kappa; they just cannot name anybody.
      if (others.length < 2) continue;
      coRated += 1;
      const agreeing = others.filter((polarity) => polarity === own).length;
      // Deviant only against a clear majority of the others; an even split is
      // not the observer being wrong, it is the room being unclear.
      if (agreeing * 2 < others.length) deviant += 1;
    }
    const deviationRate = coRated === 0 ? 0 : deviant / coRated;
    observerDeviations.push(Object.freeze({
      observerAccountId,
      coRatedItems: coRated,
      deviantItems: deviant,
      deviationRate,
      systematicallyDeviant: coRated > 0 && deviationRate > policy.maximumObserverDeviation,
    }));
  }

  if (observerDeviations.some((observer) => observer.systematicallyDeviant)) {
    reasons.push('RELIABILITY_OBSERVER_DEVIANT');
  }

  let verdict: ReliabilityVerdict;
  if (kappa >= policy.minimumKappa) {
    verdict = 'reliable';
  } else {
    reasons.push('RELIABILITY_KAPPA_BELOW_POLICY');
    verdict = 'below_policy';
  }

  return Object.freeze({
    coRatedItems: Object.freeze(items),
    observedAgreement,
    chanceAgreement,
    kappa,
    observerDeviations: Object.freeze(observerDeviations),
    verdict,
    reasons: Object.freeze(reasons),
    policyVersion: policy.policyVersion,
  });
}
