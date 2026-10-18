/**
 * SHADOW deterministic formula types.
 *
 * These types deliberately separate observations from derived results. A
 * caller may never substitute a missing value with zero: `value: null` must
 * flow to an explicit unavailable result.
 */

export const FORMULA_IDS = [
  'CORE-01',
  'CORE-02',
  'CORE-03',
  'CORE-04',
  'CORE-05',
  'CORE-06',
  'CORE-07',
  'CORE-08',
  'CORE-09',
  'CORE-10',
  'CORE-11',
  'CORE-12',
  'CORE-13',
  'MVP-01',
  'MVP-02',
  'MVP-03',
  'MVP-04',
  'MVP-05',
  'MVP-06',
  'MVP-07',
  'MVP-08',
  'MVP-09',
  'MVP-10',
  'MVP-11',
  'MVP-12',
  'BF-01',
  'BF-02',
  'BF-03',
  'BF-04',
  'BF-05',
  'BF-06',
  'BF-07',
  'BF-08',
  'BF-09',
  'BF-10',
  'BF-11',
  'BF-12',
  'BF-13',
  'LEGACY-READINESS',
] as const;

export type FormulaId = (typeof FORMULA_IDS)[number];

export type FormulaSupport = 'implemented' | 'primitive_only' | 'unsupported' | 'experimental_unsupported';

/**
 * The context every check-in observation is filed under (`check-in:<id>`, also
 * used by athleteBodyMass.ts), and the check-in items that have a personal
 * baseline (MVP-09; metricKey = the check-in column). A check-in baseline is
 * computed from check-in answers only: the observations route refuses numeric
 * writes into these contexts, and the runner refuses an MVP-09 for one of these
 * items built from anything else (lane L50).
 */
export const CHECK_IN_CONTEXT_PREFIX = 'check-in:';

/**
 * The one policy a check-in baseline runs under (Jason 2026-10-17,
 * OD-2026-10-17-020: the athlete's own last 28 days, from 7 check-ins,
 * "provisional" until 14). The runner refuses any other for a check-in item.
 */
export const CHECK_IN_BASELINE_POLICY = Object.freeze({
  windowDays: 28,
  minimumHistory: 7,
  adequateHistory: 14,
  policyVersion: 'check-in-baseline-2026-10-17',
});

/**
 * The check-in items with a personal baseline, by check-in column. SD floors
 * relayed by Overwatch (QD1): 0.5 point for the 1-5 ratings, 0.5 h for sleep.
 * Stress added on Jason's "Mood + stress (Rec.)" (relayed by Overwatch
 * 2026-10-18); mood follows once its check-in column exists (lane L58).
 */
export const CHECK_IN_BASELINE_METRICS = Object.freeze([
  Object.freeze({ metricKey: 'sleep_hours', unit: 'hours', sdFloor: 0.5 }),
  Object.freeze({ metricKey: 'energy', unit: 'rating_1_5', sdFloor: 0.5 }),
  Object.freeze({ metricKey: 'soreness', unit: 'rating_1_5', sdFloor: 0.5 }),
  Object.freeze({ metricKey: 'stress', unit: 'rating_1_5', sdFloor: 0.5 }),
] as const);

export const CHECK_IN_BASELINE_METRIC_KEYS: readonly string[] = Object.freeze(
  CHECK_IN_BASELINE_METRICS.map((metric) => metric.metricKey),
);

/**
 * The tag on the sparring page's whole-session counts ("Whole session" boxes).
 * Shared by the page that writes it and the detector that reads it
 * (runner.ts FORMULA_INPUT_REQUIREMENTS), so the two cannot spell it apart.
 */
export const SESSION_TOTAL_DIMENSIONS: Readonly<Record<string, string>> = Object.freeze({
  scope: 'session_total',
});

export const OBSERVATION_KINDS = [
  'session_rpe',
  'duration',
  'scheduled_sessions',
  'attended_sessions',
  'session_load',
  'acute_load',
  'chronic_load',
  'punch_count',
  'punch_attempted',
  'punch_landed',
  'punch_absorbed',
  'active_time',
  'round_count',
  'contact_level',
  'contact_rounds',
  'round_output',
  'focus_achieved',
  'body_weight',
  // Athlete-reported safety signals. They are stored like any other
  // observation and routed to coach review; no registered formula consumes
  // them, so they carry no derived result.
  'pain_report',
  'recovery_notes',
  'numeric',
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const FORMULA_UNITS = [
  'rpe_0_10',
  'severity_1_10',
  'minutes',
  'seconds',
  'count',
  'percent',
  'au',
  'ratio',
  'level_0_3',
  'kilograms',
  'pounds',
  'boolean_0_1',
  // Presence marker for a free-text observation: the text itself lives in
  // `dimensions`, never in `value`, because a numeric value must stay
  // computable.
  'text_present_0_1',
  'unitless',
  // Check-in self-reports read by the personal baseline (MVP-09): sleep is a
  // quantity in hours, energy and soreness a 1-5 rating (wellnessScales.ts).
  'hours',
  'rating_1_5',
] as const;

export type FormulaUnit = (typeof FORMULA_UNITS)[number];

export type ObservationSourceType =
  | 'computer_vision'
  | 'imu'
  | 'wearable'
  | 'system_timer'
  | 'sensor'
  | 'manual'
  | 'coach_tag'
  | 'imported';

export type SourceQuality = 'verified' | 'high' | 'moderate' | 'low' | 'failed';

export interface ObservationSource {
  readonly type: ObservationSourceType;
  readonly quality: SourceQuality;
  readonly referenceId: string;
  readonly qualityNotes?: string;
}

export interface NumericObservation<
  TKind extends ObservationKind = ObservationKind,
  TUnit extends FormulaUnit = FormulaUnit,
> {
  readonly observationId: string;
  readonly organizationId: string;
  readonly athleteId: string | null;
  /**
   * Identifies the session, reporting period, or load window shared by the
   * inputs to one calculation.
   */
  readonly contextId: string;
  readonly kind: TKind;
  readonly value: number | null;
  readonly unit: TUnit;
  /**
   * Formula-specific labels such as round number, punch type, field key, or
   * metric key. Dimensions are descriptive only and never replace a typed
   * observation kind or unit.
   */
  readonly dimensions?: Readonly<Record<string, string | number | boolean | null>>;
  readonly observedAt: string;
  readonly source: ObservationSource;
  readonly idempotencyKey?: string;
  readonly supersedesObservationId?: string | null;
}

export type ValidationState = 'valid' | 'warning' | 'invalid' | 'insufficient' | 'unsupported';

export type ValidationReasonCode =
  | 'MISSING_RPE'
  | 'MISSING_DURATION'
  | 'RPE_OUT_OF_RANGE'
  | 'LANDED_GT_ATTEMPTED'
  | 'ZERO_ATTEMPTS'
  | 'ZERO_ACTIVE_TIME'
  | 'MISSING_LANDED'
  | 'MISSING_ABSORBED'
  | 'INSUFFICIENT_ROUNDS'
  | 'INSUFFICIENT_HISTORY'
  | 'INVALID_CONTACT_LEVEL'
  | 'MISSING_WEIGHT'
  | 'DIV_BY_ZERO'
  | 'SOURCE_QUALITY_FAIL'
  | 'INSUFFICIENT_DATA'
  | 'ZERO_VARIANCE'
  | 'FALLBACK_SOURCE_USED'
  | 'PARTIAL_FIELDS'
  | 'SHORT_BASELINE'
  | 'STALE_DATA'
  | 'EXTREME_VALUE'
  | 'NON_FINITE_VALUE'
  | 'NEGATIVE_VALUE'
  | 'NON_INTEGER_COUNT'
  | 'ATTENDED_GT_SCHEDULED'
  | 'INVALID_WINDOW'
  | 'INVALID_LAMBDA'
  | 'ZERO_CHRONIC_LOAD'
  | 'UNIT_MISMATCH'
  | 'OBSERVATION_KIND_MISMATCH'
  | 'ORGANIZATION_SCOPE_MISMATCH'
  | 'ATHLETE_SCOPE_MISMATCH'
  | 'CONTEXT_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'OBSERVATIONS_NOT_CHRONOLOGICAL'
  | 'SOURCE_QUALITY_WARNING'
  | 'MISSING_PUNCH_COUNT'
  | 'MISSING_ACTIVE_TIME'
  | 'MISSING_ATTEMPTED'
  | 'MISSING_CONTACT_LEVEL'
  | 'MISSING_ROUNDS'
  | 'MISSING_FOCUS'
  | 'ZERO_MEAN'
  | 'INVALID_BINARY_VALUE'
  | 'INVALID_DIMENSION'
  | 'DIMENSION_MISMATCH'
  | 'INCOMPLETE_WINDOW'
  | 'INVALID_POLICY'
  | 'DATE_WINDOW_MISMATCH'
  | 'SUPERSEDED_OBSERVATION'
  | 'OBSERVATION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_FORMULA';

export interface ValidationSummary {
  readonly state: ValidationState;
  readonly hardBlocks: readonly ValidationReasonCode[];
  readonly warnings: readonly ValidationReasonCode[];
}

export type ConfidenceState = 'HIGH' | 'MODERATE' | 'LOW' | 'INSUFFICIENT';

export interface ResultQuality {
  readonly confidence: ConfidenceState;
  readonly completeness: number;
  readonly worstSourceQuality: SourceQuality | null;
}

export interface ProvenanceSnapshot {
  readonly observationId: string;
  readonly kind: ObservationKind;
  readonly unit: FormulaUnit;
  readonly observedAt: string;
  readonly sourceType: ObservationSourceType;
  readonly sourceQuality: SourceQuality;
  readonly sourceReferenceId: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FormulaResult {
  readonly resultId: string;
  readonly calculationKey: string;
  readonly formulaId: FormulaId;
  readonly formulaVersion: string;
  readonly outputKey: string;
  readonly policyVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly organizationId: string | null;
  readonly athleteId: string | null;
  readonly contextId: string | null;
  readonly value: number | null;
  readonly unit: FormulaUnit;
  readonly computedAt: string;
  readonly inputObservationIds: readonly string[];
  readonly provenance: readonly ProvenanceSnapshot[];
  readonly validation: ValidationSummary;
  readonly quality: ResultQuality;
  readonly unavailableReason: ValidationReasonCode | null;
  readonly humanReviewRequired: boolean;
}

export interface FormulaOutputDefinition {
  readonly key: string;
  /**
   * `input_unit` is used for formulas such as raw baseline or weight change,
   * whose safe output unit must exactly match the validated input unit.
   */
  readonly unit: FormulaUnit | 'input_unit';
  readonly description: string;
}

export interface FormulaDefinition {
  readonly id: FormulaId;
  readonly version: string;
  readonly name: string;
  readonly expression: string;
  readonly support: FormulaSupport;
  readonly outputUnit: FormulaUnit;
  readonly outputs: readonly FormulaOutputDefinition[];
  readonly requiredObservationKinds: readonly ObservationKind[];
  readonly humanReviewRequired: boolean;
  readonly unsupportedReason?: string;
  readonly implementation?: string;
}

export type MvpFormulaId =
  | 'MVP-01'
  | 'MVP-02'
  | 'MVP-03'
  | 'MVP-04'
  | 'MVP-05'
  | 'MVP-06'
  | 'MVP-07'
  | 'MVP-08'
  | 'MVP-09'
  | 'MVP-10'
  | 'MVP-11'
  | 'MVP-12';

export type FormulaHistoryStatus = 'insufficient_history' | 'building' | 'adequate';

export interface FormulaBaselineSnapshot {
  readonly calculationKey: string;
  readonly organizationId: string;
  readonly athleteId: string;
  readonly formulaId: 'MVP-09';
  readonly formulaVersion: string;
  readonly metricKey: string;
  readonly unit: FormulaUnit;
  readonly policyVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly windowSize: number;
  readonly historyStatus: FormulaHistoryStatus;
  readonly baselineMean: number | null;
  readonly baselineSampleSd: number | null;
  readonly observationIds: readonly string[];
  readonly effectiveAt: string;
}

export interface NumericSuccess {
  readonly ok: true;
  readonly value: number;
}

export interface NumericFailure {
  readonly ok: false;
  readonly reason: ValidationReasonCode;
}

export type NumericOutcome = NumericSuccess | NumericFailure;

export interface NumericSeriesSuccess {
  readonly ok: true;
  readonly value: number;
  readonly series: readonly number[];
}

export interface NumericSeriesFailure {
  readonly ok: false;
  readonly reason: ValidationReasonCode;
}

export type NumericSeriesOutcome = NumericSeriesSuccess | NumericSeriesFailure;
