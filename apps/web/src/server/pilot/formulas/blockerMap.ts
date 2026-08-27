/**
 * SHADOW formula blocker map -- a DERIVED read model over
 * `SHADOW_FORMULA_REGISTRY`. No table, no migration, no second source of
 * truth: `support` and `reasonVerbatim` are read out of the registry on every
 * access and are never restated here.
 *
 * ## What this answers, and what it deliberately does not
 *
 * 39 formulas are registered. 18 of them are blocked (`unsupported` or
 * `experimental_unsupported`) and carry a prose `unsupportedReason`. Nothing
 * until now sorted those reasons into KINDS of blocker, so "what would unblock
 * this formula" could only be answered by reading 18 sentences.
 *
 * The one thing this map may not do is guess. A category is assigned ONLY
 * where the registry's own prose states it, and every assignment carries the
 * literal phrase that licensed it (`FORMULA_BLOCKER_CATEGORY_EVIDENCE`), which
 * `blockerMap.test.ts` asserts is still a substring of the current reason. So
 * a reason edited in `registry.ts` turns the classification red rather than
 * leaving it quietly wrong.
 *
 * **An empty `categories` array IS the classification: it means
 * NEEDS_OWNER_CLASSIFICATION.** There is no sentinel string, no default, and
 * no "uncategorised" member of `BlockerCategory`. 24 of 39 land there. That is
 * the honest number and it is meant to be uncomfortable.
 *
 * `categories` is a SET rather than a scalar because 10 of the 15 classified
 * reasons state more than one kind of blocker in one sentence -- "Segment-level
 * RPE, duration, and approved segment taxonomy are not available" names
 * missing data, a missing taxonomy and a missing approval. A single-valued
 * field would have forced a pick between them, which is the guess this map
 * exists to avoid.
 *
 * ## What this map does NOT change
 *
 * Nothing about the formulas themselves. No formula's mathematics, support
 * state, `requiredObservationKinds`, or reason text is touched by this file.
 * It is read-only over the registry by construction.
 *
 * ## Known follow-up, recorded rather than fixed here
 *
 * All 18 blocked formulas have `requiredObservationKinds: []`, because the
 * `unsupported()` helper in `registry.ts` has no parameter for it -- every
 * populated instance belongs to an `implemented` entry. So DATA_GAP versus
 * INTEGRATION_GAP is **not mechanically computable**: the prose is the only
 * source. Populating those arrays is real formula-contract work that would
 * change what the registry asserts about 18 formulas, so it is not done here.
 *
 * ## Bridge, not duplicate
 *
 * `pilot.shadow_research_requirements` already exists and is already unique on
 * `(organization_id, source_event_name, source_entity_type, source_entity_id)`.
 * `buildFormulaBlockerResearchRequirement` below turns one `FormulaBlocker`
 * into the arguments for the existing `createShadowResearchRequirement`, and
 * that unique index gives one row per formula per organisation for free. This
 * file never calls it.
 */

import { SHADOW_FORMULA_REGISTRY, getFormulaDefinition } from './registry';
import { FORMULA_IDS, type FormulaId, type FormulaSupport } from './types';
import type { ShadowResearchRequirementInput } from '../shadowResearch';

/**
 * The kinds of thing that stand between a registered formula and a result.
 *
 * Declaration order is the canonical output order for `categories`, so two
 * blockers with the same categories compare equal by value.
 *
 * - `DATA_GAP` -- a required observation or measurement is not captured.
 * - `INTEGRATION_GAP` -- the data is captured but is not connected to the
 *   formula. Assigned to nothing today: see the module note above, and the
 *   three contradictions below, which are the closest the registry comes to
 *   describing one and are deliberately NOT reclassified as one.
 * - `TAXONOMY_GAP` -- a classification, labelling, or typing scheme the
 *   formula depends on does not exist.
 * - `RESEARCH_GAP` -- the underlying construct's validity is unestablished and
 *   external evidence is what would settle it.
 * - `CALIBRATION_GAP` -- coefficients, weights, scales, or thresholds are
 *   unproven or uncalibrated.
 * - `POLICY_DECISION` -- something must be approved or decided by a human with
 *   the authority to decide it.
 * - `SAFETY_REVIEW_REQUIRED` -- clinical, safety, or fairness validity governs
 *   whether the formula may run at all.
 */
export const BLOCKER_CATEGORIES = [
  'DATA_GAP',
  'INTEGRATION_GAP',
  'TAXONOMY_GAP',
  'RESEARCH_GAP',
  'CALIBRATION_GAP',
  'POLICY_DECISION',
  'SAFETY_REVIEW_REQUIRED',
] as const;

export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

/**
 * The support states that mean "this formula cannot produce a governed
 * result". `primitive_only` is deliberately NOT here: whether a primitive
 * counts as blocked at all is an open question this map does not answer, and
 * the four `primitive_only` entries carry that question as their owner note.
 */
export const BLOCKED_SUPPORT_STATES: readonly FormulaSupport[] = Object.freeze([
  'unsupported',
  'experimental_unsupported',
]);

export function isBlockedSupport(support: FormulaSupport): boolean {
  return BLOCKED_SUPPORT_STATES.includes(support);
}

export interface FormulaBlocker {
  readonly formulaId: FormulaId;
  /** Read from the registry on access. Never restated in this file. */
  readonly support: FormulaSupport;
  /** The registry's own `unsupportedReason`, unedited, or null when it states none. */
  readonly reasonVerbatim: string | null;
  /**
   * A SET. Empty means NEEDS_OWNER_CLASSIFICATION -- not "no blocker" and not
   * "not yet looked at". Every member is licensed by a phrase in
   * `FORMULA_BLOCKER_CATEGORY_EVIDENCE`.
   */
  readonly categories: readonly BlockerCategory[];
  /** The question being put to the owner, or a check worth recording. */
  readonly ownerNote?: string;
}

/**
 * The exact substring of `reasonVerbatim` that licensed one category. This is
 * the audit trail that makes "derived only from explicit text" checkable
 * rather than asserted: the test asserts each phrase is still literally
 * present in the registry's current reason.
 */
export interface BlockerCategoryEvidence {
  readonly category: BlockerCategory;
  readonly phrase: string;
}

interface ClassificationEntry {
  readonly evidence: readonly BlockerCategoryEvidence[];
  readonly ownerNote?: string;
}

// --- Owner notes shared by the entries that state no reason at all ---------

const NO_REASON_PREAMBLE =
  'NEEDS_OWNER_CLASSIFICATION. The registry records no unsupportedReason for this formula, so there is no text to derive a category from.';

const IMPLEMENTED_MVP_NOTE =
  `${NO_REASON_PREAMBLE} Support is 'implemented'. Whether an implemented formula belongs in a blocker map at all -- as an explicit NOT_BLOCKED state rather than as a category -- is an owner decision this map does not make.`;

const IMPLEMENTED_NO_MVP_PATH_NOTE =
  `${NO_REASON_PREAMBLE} Support is 'implemented', and this id is outside the MVP-01..MVP-12 set that the MvpFormulaId union (formulas/types.ts) admits, so no persisted run path names it. That is a check on the type, not a reading of intent: nothing states whether the absence is a blocker, and INTEGRATION_GAP is not assigned because inferring it from structure is exactly the guess this map refuses.`;

const PRIMITIVE_ONLY_NOTE =
  `${NO_REASON_PREAMBLE} Support is 'primitive_only'. Whether 'primitive_only' is a blocked state at all is itself unanswered -- a primitive that is doing its job needs nothing, and one that is standing in for an unbuilt formula needs a great deal. Owner decision.`;

// --- Owner notes for the three contradicted reasons -----------------------

const ABSORBED_PUNCH_EVIDENCE =
  "'punch_absorbed' is a registered ObservationKind (formulas/types.ts), is POSTed to /api/pilot/shadow/formulas/observations by app/athlete/dashboard/sparring/page.tsx, and is a requiredObservationKind of MVP-04 (Connect Differential), whose support is 'implemented'.";

const BF02_OWNER_NOTE =
  `CONTRADICTION, surfaced rather than reclassified. The reason lists 'absorbed punches' among observations that 'are not available', but ${ABSORBED_PUNCH_EVIDENCE} The other three clauses -- counter opportunities, counter attempts, landed counters -- name nothing in OBSERVATION_KINDS and are uncontradicted, so DATA_GAP would be licensed for them alone. Because one stated ground is falsified and the rest are not, the formula-level classification is unresolved and this map assigns nothing. Reclassifying it as INTEGRATION_GAP would be inventing a reason the registry does not give. NEEDS_OWNER_CLASSIFICATION.`;

const BF03_OWNER_NOTE =
  `CONTRADICTION, surfaced rather than reclassified. The reason says 'validated absorbed-punch observations are not available', and ${ABSORBED_PUNCH_EVIDENCE} The qualifier 'validated' is the whole question and nothing checked here defines it, so whether the reason is false or merely narrower than it reads is unresolved. 'Opponent attempts' names nothing in OBSERVATION_KINDS and is uncontradicted. NEEDS_OWNER_CLASSIFICATION.`;

const BF11_OWNER_NOTE =
  "CONTRADICTION, surfaced rather than reclassified. The reason says 'Immutable personal baselines and a calibrated versioned threshold are not available', but buildPersonalBaselineSnapshot exists in formulas/baseline.ts and MVP-09 (Personal Baseline Comparison, support 'implemented') emits a FormulaBaselineSnapshot. The qualifier 'Immutable' is not verified -- nothing checked here establishes whether an emitted snapshot is immutable, and that is the load-bearing word. The second clause, 'a calibrated versioned threshold', is uncontradicted and would read as CALIBRATION_GAP on its own; it is RECORDED here rather than assigned, because the formula-level classification is unresolved. NEEDS_OWNER_CLASSIFICATION.";

// --- Adjacency notes: checks run, deliberately not treated as findings -----

const ADJACENCY_PREAMBLE =
  'Adjacency noted, not treated as a contradiction:';

const CORE_DAILY_LOAD_ADJACENCY =
  `${ADJACENCY_PREAMBLE} the reason names daily load, and 'session_load' is a registered ObservationKind consumed by CORE-11 and CORE-12. Session and day are different windows, so the reason is not contradicted by that kind's existence; whether the daily stream can be derived from it is an unasked question, not a finding.`;

const BF07_OUTPUT_ADJACENCY =
  `${ADJACENCY_PREAMBLE} the reason names 'Ordered session output observations', and 'round_output' is a registered ObservationKind consumed by MVP-07 and MVP-08. Round and session are different scopes, so this is recorded as a near miss rather than scored as a contradiction. The check run was an exact-name comparison against OBSERVATION_KINDS; no attempt was made to judge whether round output aggregates to session output.`;

/**
 * The classification, hand-derived from the registry's own prose, one entry
 * per registered formula.
 *
 * `Record<FormulaId, ...>` makes a newly registered formula a TYPE error --
 * enforced by `npm run typecheck`, not by jest, which runs with diagnostics
 * off. The completeness test in `blockerMap.test.ts` is what catches it at
 * runtime.
 */
export const FORMULA_BLOCKER_CLASSIFICATION: Readonly<Record<FormulaId, ClassificationEntry>> = Object.freeze({
  'CORE-01': { evidence: [], ownerNote: IMPLEMENTED_NO_MVP_PATH_NOTE },
  'CORE-02': { evidence: [], ownerNote: IMPLEMENTED_NO_MVP_PATH_NOTE },
  'CORE-03': { evidence: [], ownerNote: PRIMITIVE_ONLY_NOTE },
  'CORE-04': { evidence: [], ownerNote: PRIMITIVE_ONLY_NOTE },
  'CORE-05': {
    // 'Metric-specific required-field schemas have not been approved. A
    //  profile-completeness heuristic is not an observation-completeness formula.'
    evidence: [
      { category: 'TAXONOMY_GAP', phrase: 'Metric-specific required-field schemas' },
      { category: 'POLICY_DECISION', phrase: 'have not been approved' },
    ],
  },
  'CORE-06': {
    // 'Daily load observations and an approved zero-variance policy are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Daily load observations' },
      { category: 'POLICY_DECISION', phrase: 'an approved zero-variance policy' },
    ],
    ownerNote: CORE_DAILY_LOAD_ADJACENCY,
  },
  'CORE-07': {
    // 'Depends on an approved training-monotony result and complete daily-load observations.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'complete daily-load observations' },
      { category: 'POLICY_DECISION', phrase: 'an approved training-monotony result' },
    ],
    ownerNote: CORE_DAILY_LOAD_ADJACENCY,
  },
  'CORE-08': { evidence: [], ownerNote: PRIMITIVE_ONLY_NOTE },
  'CORE-09': {
    // 'Paired repeated-measure observations and a pairing policy are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Paired repeated-measure observations' },
      { category: 'POLICY_DECISION', phrase: 'a pairing policy' },
    ],
  },
  'CORE-10': { evidence: [], ownerNote: PRIMITIVE_ONLY_NOTE },
  'CORE-11': { evidence: [], ownerNote: IMPLEMENTED_NO_MVP_PATH_NOTE },
  'CORE-12': { evidence: [], ownerNote: IMPLEMENTED_NO_MVP_PATH_NOTE },
  'CORE-13': { evidence: [], ownerNote: IMPLEMENTED_NO_MVP_PATH_NOTE },
  'MVP-01': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-02': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-03': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-04': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-05': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-06': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-07': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-08': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-09': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-10': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-11': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'MVP-12': { evidence: [], ownerNote: IMPLEMENTED_MVP_NOTE },
  'BF-01': {
    // 'Typed combination attempts, punches, and landed combinations are not available.'
    // 'Typed' describes the shape of the missing observation; the sentence's
    // predicate is availability, so no TAXONOMY_GAP is read into it.
    evidence: [{ category: 'DATA_GAP', phrase: 'are not available' }],
  },
  'BF-02': { evidence: [], ownerNote: BF02_OWNER_NOTE },
  'BF-03': { evidence: [], ownerNote: BF03_OWNER_NOTE },
  'BF-04': {
    // 'Power-punch classifications, attempts, and landed observations are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'attempts, and landed observations are not available' },
      { category: 'TAXONOMY_GAP', phrase: 'Power-punch classifications' },
    ],
  },
  'BF-05': {
    // 'Validated target-location observations are not available.'
    // No target-location kind exists in OBSERVATION_KINDS, so unlike BF-03 the
    // 'Validated' qualifier is not doing contradicted work here.
    evidence: [{ category: 'DATA_GAP', phrase: 'target-location observations are not available' }],
  },
  'BF-06': {
    // 'Segmented work/rest timing observations are not available.'
    evidence: [{ category: 'DATA_GAP', phrase: 'Segmented work/rest timing observations are not available' }],
  },
  'BF-07': {
    // 'Ordered session output observations and a session-halving policy are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Ordered session output observations' },
      { category: 'POLICY_DECISION', phrase: 'a session-halving policy' },
    ],
    ownerNote: BF07_OUTPUT_ADJACENCY,
  },
  'BF-08': {
    // 'Technical-goal opportunities/outcomes and ordered session segments are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Technical-goal opportunities/outcomes and ordered session segments are not available' },
    ],
  },
  'BF-09': {
    // 'Segment-level RPE, duration, and approved segment taxonomy are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Segment-level RPE, duration' },
      { category: 'TAXONOMY_GAP', phrase: 'segment taxonomy' },
      { category: 'POLICY_DECISION', phrase: 'approved segment taxonomy' },
    ],
  },
  'BF-10': {
    // 'Impact, confidence, recency, and research-flag weights are uncalibrated and not approved.'
    evidence: [
      { category: 'CALIBRATION_GAP', phrase: 'weights are uncalibrated' },
      { category: 'POLICY_DECISION', phrase: 'not approved' },
    ],
  },
  'BF-11': { evidence: [], ownerNote: BF11_OWNER_NOTE },
  'BF-12': {
    // 'Guard-recovery opportunities, outcomes, and timestamps are not available.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Guard-recovery opportunities, outcomes, and timestamps are not available' },
    ],
  },
  'BF-13': {
    // 'Center-zone tracking is unavailable and coach ordinal ratings must
    //  remain separately labeled observations.'
    evidence: [
      { category: 'DATA_GAP', phrase: 'Center-zone tracking is unavailable' },
      { category: 'POLICY_DECISION', phrase: 'must remain separately labeled observations' },
    ],
  },
  'LEGACY-READINESS': {
    // 'Coefficients, input scales, fairness, and clinical/safety validity are
    //  unproven. It must not clear, restrict, or prescribe training.'
    evidence: [
      { category: 'RESEARCH_GAP', phrase: 'fairness' },
      { category: 'CALIBRATION_GAP', phrase: 'Coefficients, input scales' },
      { category: 'SAFETY_REVIEW_REQUIRED', phrase: 'clinical/safety validity are unproven' },
    ],
  },
});

export const FORMULA_BLOCKER_CATEGORY_EVIDENCE: Readonly<Record<FormulaId, readonly BlockerCategoryEvidence[]>> =
  Object.freeze(
    Object.fromEntries(
      FORMULA_IDS.map((id) => [id, Object.freeze([...FORMULA_BLOCKER_CLASSIFICATION[id].evidence])]),
    ) as Record<FormulaId, readonly BlockerCategoryEvidence[]>,
  );

function categoriesFor(id: FormulaId): readonly BlockerCategory[] {
  const stated = new Set(FORMULA_BLOCKER_CLASSIFICATION[id].evidence.map((item) => item.category));
  return Object.freeze(BLOCKER_CATEGORIES.filter((category) => stated.has(category)));
}

function blockerFor(id: FormulaId): FormulaBlocker {
  const definition = getFormulaDefinition(id);
  const entry = FORMULA_BLOCKER_CLASSIFICATION[id];
  return Object.freeze({
    formulaId: id,
    support: definition.support,
    reasonVerbatim: definition.unsupportedReason ?? null,
    categories: categoriesFor(id),
    ...(entry.ownerNote === undefined ? {} : { ownerNote: entry.ownerNote }),
  });
}

/**
 * Every registered formula, in registry order. Built from
 * `SHADOW_FORMULA_REGISTRY` rather than from `FORMULA_IDS` so the order is the
 * registry's own and cannot drift from it.
 */
export const SHADOW_FORMULA_BLOCKERS: readonly FormulaBlocker[] = Object.freeze(
  SHADOW_FORMULA_REGISTRY.map((definition) => blockerFor(definition.id)),
);

const blockerById = new Map<FormulaId, FormulaBlocker>(
  SHADOW_FORMULA_BLOCKERS.map((entry) => [entry.formulaId, entry]),
);

export function getFormulaBlocker(formulaId: FormulaId): FormulaBlocker {
  const result = blockerById.get(formulaId);
  if (!result) {
    throw new Error(`Unknown SHADOW formula ID: ${formulaId}`);
  }
  return result;
}

/** `[]` is the marker. This names it so a call site does not have to. */
export function needsOwnerClassification(blocker: FormulaBlocker): boolean {
  return blocker.categories.length === 0;
}

export interface FormulaBlockerResearchBridgeInput {
  readonly blocker: FormulaBlocker;
  readonly organizationId: string;
  readonly createdByAccountId: string;
  readonly createdByRole: string;
}

/**
 * The bridge into the EXISTING research-requirement system. It builds
 * arguments; it does not write. Nothing in this PR calls it.
 *
 * Why this shape:
 *
 * - `sourceEntityType: 'formula_id'` and `sourceEntityId: <FormulaId>` make the
 *   formula itself the entity, so the table's
 *   `unique (organization_id, source_event_name, source_entity_type, source_entity_id)`
 *   yields exactly one open row per formula per organisation. Re-running this
 *   over all 39 is idempotent through `createShadowResearchRequirement`'s
 *   `on conflict ... do update` no-op, with no dedup query of its own -- unlike
 *   the shadowLibrary writers, which have to scan open rows because their
 *   entity id embeds a timestamp.
 * - `subjectId: null` because a formula blocker is org-wide and is about no
 *   athlete. `shadowResearch.ts` already documents null as exactly that.
 * - `knowledgeGap` is the registry's reason VERBATIM. Where the registry states
 *   no reason, the gap says so and names the check, rather than composing a
 *   plausible one -- a research requirement whose knowledge gap this code made
 *   up is the invented authority the registry exists to prevent.
 * - The derived classification travels in `metadata`, never in the prose, so a
 *   later reader can always tell the registry's words from this map's reading
 *   of them.
 * - `sourceStatus: 'missing'` matches how the shadowLibrary writers use the
 *   column: the thing the requirement asks for is absent, not merely thin.
 */
export function buildFormulaBlockerResearchRequirement(
  input: FormulaBlockerResearchBridgeInput,
): ShadowResearchRequirementInput {
  const { blocker } = input;
  const unclassified = needsOwnerClassification(blocker);

  return {
    organizationId: input.organizationId,
    sourceEventName: 'SHADOW_FORMULA_BLOCKER_CLASSIFIED',
    sourceEntityType: 'formula_id',
    sourceEntityId: blocker.formulaId,
    researchRequirement: unclassified
      ? `Classify the SHADOW formula blocker for ${blocker.formulaId}`
      : `Close the SHADOW formula blocker for ${blocker.formulaId} (${blocker.categories.join(', ')})`,
    knowledgeGap:
      blocker.reasonVerbatim
      ?? `SHADOW_FORMULA_REGISTRY records no unsupportedReason for ${blocker.formulaId} (support '${blocker.support}'), so no blocker text exists to classify.`,
    evidenceLabel: blocker.formulaId,
    subjectId: null,
    sourceStatus: 'missing',
    sourceConfidenceTier: 'INSUFFICIENT',
    sourceVerificationState: 'unknown',
    createdByAccountId: input.createdByAccountId,
    createdByRole: input.createdByRole,
    metadata: {
      formula_id: blocker.formulaId,
      support: blocker.support,
      categories: [...blocker.categories],
      needs_owner_classification: unclassified,
      ...(blocker.ownerNote === undefined ? {} : { owner_note: blocker.ownerNote }),
    },
  };
}
