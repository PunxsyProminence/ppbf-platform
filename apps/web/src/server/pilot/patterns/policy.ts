/**
 * The ratified bar a pattern candidate must clear.
 *
 * WHY THIS IS AN INPUT AND NOT A CONSTANT
 *
 * No evidence in this repository, in the PPBF research corpus, or in
 * `docs/SHADOW_ML_ARCHITECTURE_SPEC.md` establishes a universal occurrence
 * threshold for behavioural pattern formation. "Three observations = a
 * confirmed pattern" is a number somebody would have to invent, and once
 * invented it would be indistinguishable, downstream, from a measured one --
 * it would appear in a coach-facing UI, in an athlete overlay, and
 * eventually in a sentence beginning "SHADOW determined that".
 *
 * So this module ships NO default policy. A caller must supply one, and the
 * policy must name the account that ratified it. That makes every threshold
 * in the system attributable to a person who can be asked why, and makes a
 * change of bar a versioned, auditable event rather than a diff to a
 * constant. It follows the same shape as `formulas/baseline.ts`'s
 * `BaselinePolicy`, which is already injected and version-stamped for the
 * numeric ladder.
 *
 * The validation below checks INTERNAL COHERENCE only -- that counts are
 * positive integers and ratios are ratios. It deliberately does not police
 * whether a bar is scientifically sensible, because this module has no
 * standing to know that and pretending otherwise would smuggle the invented
 * threshold back in as a validation rule.
 */

export interface PatternFormationPolicy {
  /** Stamped into every evaluation, so a result can be traced to its bar. */
  readonly policyVersion: string;
  /** The human who owns this bar. Required; there is no anonymous policy. */
  readonly ratifiedByAccountId: string;
  readonly ratifiedAt: string;

  /** Occurrences (counterexamples excluded) required before proposing. */
  readonly minimumOccurrences: number;
  /** Distinct sessions -- "seen again on another day". */
  readonly minimumDistinctSessions: number;
  /** Distinct drills/tasks -- "not an artefact of one drill". */
  readonly minimumDistinctTaskContexts: number;
  /** Distinct human observers -- "more than one person's judgement". */
  readonly minimumDistinctObservers: number;

  /** When true, AI-proposed observations alone can never leave abstention. */
  readonly requireHumanObservation: boolean;
  /** When true, the behaviour must appear in both a controlled and a live task. */
  readonly requireConstraintSpan: boolean;
  /** When true, a behaviour confined to one fatigue state cannot be proposed. */
  readonly requireFatigueDiversity: boolean;
  /** When true, at least one occurrence must be video-corroborated. */
  readonly requireVideoCorroboration: boolean;

  /**
   * counterexamples / occurrences at or above which the candidate is
   * CONTESTED rather than proposable. A ratio, not a count, so it scales
   * with how much evidence exists.
   */
  readonly counterEvidenceContestRatio: number;

  /** Share of occurrences that must attribute to the athlete, 0-1. */
  readonly minimumAthleteAttributionShare: number;

  /** Evidence older than this contributes, but stops counting as recent. */
  readonly evidenceStaleAfterDays: number;
  /** First-to-last observation span required, in days. 0 disables the check. */
  readonly minimumObservationSpanDays: number;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1;
}

function isRatio(value: unknown): boolean {
  return Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1;
}

function isNonNegativeNumber(value: unknown): boolean {
  return Number.isFinite(value) && (value as number) >= 0;
}

/**
 * Throws `TypeError` on an incoherent policy, matching
 * `buildPersonalBaselineSnapshot`'s contract: an invalid policy is a caller
 * bug, not an abstention, and must not be silently coerced into a working
 * one. Coercing here would mean an evaluation ran against a bar nobody set.
 */
export function assertPatternFormationPolicy(
  policy: PatternFormationPolicy,
): void {
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('A pattern formation policy is required.');
  }
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion.trim()) {
    throw new TypeError('Pattern formation policy requires a policyVersion.');
  }
  if (typeof policy.ratifiedByAccountId !== 'string' || !policy.ratifiedByAccountId.trim()) {
    throw new TypeError(
      'Pattern formation policy requires ratifiedByAccountId: a promotion bar must be attributable to a person.',
    );
  }
  if (typeof policy.ratifiedAt !== 'string' || !Number.isFinite(Date.parse(policy.ratifiedAt))) {
    throw new TypeError('Pattern formation policy requires a valid ratifiedAt timestamp.');
  }
  if (
    !isPositiveInteger(policy.minimumOccurrences)
    || !isPositiveInteger(policy.minimumDistinctSessions)
    || !isPositiveInteger(policy.minimumDistinctTaskContexts)
    || !isPositiveInteger(policy.minimumDistinctObservers)
  ) {
    throw new TypeError('Pattern formation policy minimums must be integers of at least 1.');
  }

  // THE THREE FLOORS BELOW ARE NOT CALIBRATED NUMBERS.
  //
  // They are the arithmetic reading of methodology this organization has
  // already stated in prose: "one dramatic event is not a pattern" and
  // "patterns should appear across more than one context before being locked
  // into an athlete overlay". Both sentences mean "more than one", and "more
  // than one" is 2. A policy may set any bar AT OR ABOVE these; it may not
  // set one below, because doing so would let a single rep, a single day, or
  // a single drill become an athlete overlay -- the exact outcome the stated
  // methodology forbids.
  //
  // Nothing here claims 2 is the RIGHT bar. It is the lowest bar that is not
  // self-evidently wrong. Choosing the real one is owner authority, which is
  // why ratifiedByAccountId is mandatory above.
  if (policy.minimumOccurrences < 2) {
    throw new TypeError(
      'minimumOccurrences must be at least 2: one dramatic event is not a pattern.',
    );
  }
  if (policy.minimumDistinctSessions < 2) {
    throw new TypeError(
      'minimumDistinctSessions must be at least 2: a single session is one occasion, not a pattern.',
    );
  }
  if (policy.minimumDistinctTaskContexts < 2) {
    throw new TypeError(
      'minimumDistinctTaskContexts must be at least 2: a behaviour seen in only one task context '
      + 'has not been distinguished from an artefact of that task.',
    );
  }
  if (policy.minimumOccurrences < policy.minimumDistinctSessions) {
    throw new TypeError(
      'Pattern formation policy is incoherent: minimumDistinctSessions cannot exceed minimumOccurrences.',
    );
  }
  if (policy.minimumOccurrences < policy.minimumDistinctTaskContexts) {
    throw new TypeError(
      'Pattern formation policy is incoherent: minimumDistinctTaskContexts cannot exceed minimumOccurrences.',
    );
  }
  if (
    typeof policy.requireHumanObservation !== 'boolean'
    || typeof policy.requireConstraintSpan !== 'boolean'
    || typeof policy.requireFatigueDiversity !== 'boolean'
    || typeof policy.requireVideoCorroboration !== 'boolean'
  ) {
    throw new TypeError('Pattern formation policy requirement flags must be booleans.');
  }
  if (!isRatio(policy.counterEvidenceContestRatio)) {
    throw new TypeError('counterEvidenceContestRatio must be a ratio between 0 and 1.');
  }
  if (!isRatio(policy.minimumAthleteAttributionShare)) {
    throw new TypeError('minimumAthleteAttributionShare must be a ratio between 0 and 1.');
  }
  if (!Number.isFinite(policy.evidenceStaleAfterDays) || policy.evidenceStaleAfterDays <= 0) {
    throw new TypeError('evidenceStaleAfterDays must be a positive number of days.');
  }
  if (!isNonNegativeNumber(policy.minimumObservationSpanDays)) {
    throw new TypeError('minimumObservationSpanDays must be zero or a positive number of days.');
  }
}

/**
 * The subset of the policy stamped into an evaluation's `parameters`, so a
 * stored result records the bar it was judged against rather than only a
 * version string that some later edit could quietly redefine.
 */
export function policyParameters(
  policy: PatternFormationPolicy,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    minimumOccurrences: policy.minimumOccurrences,
    minimumDistinctSessions: policy.minimumDistinctSessions,
    minimumDistinctTaskContexts: policy.minimumDistinctTaskContexts,
    minimumDistinctObservers: policy.minimumDistinctObservers,
    requireHumanObservation: policy.requireHumanObservation,
    requireConstraintSpan: policy.requireConstraintSpan,
    requireFatigueDiversity: policy.requireFatigueDiversity,
    requireVideoCorroboration: policy.requireVideoCorroboration,
    counterEvidenceContestRatio: policy.counterEvidenceContestRatio,
    minimumAthleteAttributionShare: policy.minimumAthleteAttributionShare,
    evidenceStaleAfterDays: policy.evidenceStaleAfterDays,
    minimumObservationSpanDays: policy.minimumObservationSpanDays,
  });
}
