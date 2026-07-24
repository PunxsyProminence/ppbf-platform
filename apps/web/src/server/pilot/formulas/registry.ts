import {
  FORMULA_IDS,
  type FormulaDefinition,
  type FormulaId,
  type FormulaSupport,
  type FormulaUnit,
  type ObservationKind,
} from './types';

interface DefinitionInput {
  id: FormulaId;
  name: string;
  expression: string;
  support: FormulaSupport;
  outputUnit: FormulaUnit;
  requiredObservationKinds?: readonly ObservationKind[];
  humanReviewRequired?: boolean;
  unsupportedReason?: string;
  implementation?: string;
}

function definition(input: DefinitionInput): FormulaDefinition {
  return Object.freeze({
    ...input,
    version: '1.0.0',
    requiredObservationKinds: Object.freeze([...(input.requiredObservationKinds ?? [])]),
    humanReviewRequired: input.humanReviewRequired ?? false,
  });
}

function unsupported(
  id: FormulaId,
  name: string,
  expression: string,
  outputUnit: FormulaUnit,
  reason: string,
  humanReviewRequired = false,
): FormulaDefinition {
  return definition({
    id,
    name,
    expression,
    support: 'unsupported',
    outputUnit,
    humanReviewRequired,
    unsupportedReason: reason,
  });
}

export const SHADOW_FORMULA_REGISTRY: readonly FormulaDefinition[] = Object.freeze([
  definition({
    id: 'CORE-01',
    name: 'Session Load (sRPE)',
    expression: 'session RPE × duration minutes',
    support: 'implemented',
    outputUnit: 'au',
    requiredObservationKinds: ['session_rpe', 'duration'],
    implementation: 'calculateSessionLoad',
  }),
  definition({
    id: 'CORE-02',
    name: 'Attendance Rate',
    expression: '(attended sessions / scheduled sessions) × 100',
    support: 'implemented',
    outputUnit: 'percent',
    requiredObservationKinds: ['attended_sessions', 'scheduled_sessions'],
    implementation: 'calculateAttendanceRate',
  }),
  definition({
    id: 'CORE-03',
    name: 'Arithmetic Mean',
    expression: 'Σx / n',
    support: 'primitive_only',
    outputUnit: 'unitless',
    implementation: 'mean',
  }),
  definition({
    id: 'CORE-04',
    name: 'Sample Standard Deviation',
    expression: 'sqrt(Σ(x − mean)² / (n − 1))',
    support: 'primitive_only',
    outputUnit: 'unitless',
    implementation: 'sampleStandardDeviation',
  }),
  unsupported(
    'CORE-05',
    'Data Completeness',
    'present required fields / expected required fields',
    'ratio',
    'Metric-specific required-field schemas have not been approved. A profile-completeness heuristic is not an observation-completeness formula.',
  ),
  unsupported(
    'CORE-06',
    'Training Monotony',
    'mean daily load / sample SD of daily load',
    'ratio',
    'Daily load observations and an approved zero-variance policy are not available.',
    true,
  ),
  unsupported(
    'CORE-07',
    'Training Strain',
    'weekly load × monotony',
    'au',
    'Depends on an approved training-monotony result and complete daily-load observations.',
    true,
  ),
  definition({
    id: 'CORE-08',
    name: 'Smallest Worthwhile Change',
    expression: '0.2 × between-athlete SD or 0.3 × within-athlete CV ratio',
    support: 'primitive_only',
    outputUnit: 'unitless',
    humanReviewRequired: true,
    implementation: 'smallestWorthwhileChangeBetweenAthletes / smallestWorthwhileChangeWithinAthlete',
  }),
  unsupported(
    'CORE-09',
    'Typical Error',
    'sample SD of paired difference scores / sqrt(2)',
    'unitless',
    'Paired repeated-measure observations and a pairing policy are not available.',
    true,
  ),
  definition({
    id: 'CORE-10',
    name: 'Standardized Change',
    expression: '(current − baseline) / (sample SD or typical error)',
    support: 'primitive_only',
    outputUnit: 'ratio',
    humanReviewRequired: true,
    implementation: 'standardizedChange',
  }),
  definition({
    id: 'CORE-11',
    name: 'Rolling Mean',
    expression: 'sum of last w valid values / w',
    support: 'implemented',
    outputUnit: 'au',
    requiredObservationKinds: ['session_load'],
    implementation: 'calculateRollingLoad',
  }),
  definition({
    id: 'CORE-12',
    name: 'EWMA',
    expression: 'λxₜ + (1−λ)EWMAₜ₋₁',
    support: 'implemented',
    outputUnit: 'au',
    requiredObservationKinds: ['session_load'],
    implementation: 'calculateEwmaLoad',
  }),
  definition({
    id: 'CORE-13',
    name: 'Acute:Chronic Workload Ratio',
    expression: 'acute load / chronic load',
    support: 'implemented',
    outputUnit: 'ratio',
    requiredObservationKinds: ['acute_load', 'chronic_load'],
    humanReviewRequired: true,
    implementation: 'calculateAcuteChronicWorkloadRatio',
  }),
  definition({
    id: 'MVP-01',
    name: 'Session Load',
    expression: 'session RPE × duration minutes',
    support: 'implemented',
    outputUnit: 'au',
    requiredObservationKinds: ['session_rpe', 'duration'],
    implementation: 'calculateSessionLoad',
  }),
  unsupported('MVP-02', 'Punch Output', 'punches per round; punches / active minutes', 'ratio', 'Round-level punch counts and active-time observations are not available.'),
  unsupported('MVP-03', 'Accuracy by Punch Type', '(landed / attempted) × 100 by punch type', 'percent', 'Typed punch attempts, landed counts, and punch classifications are not available.'),
  unsupported('MVP-04', 'Connect Differential', 'landed − absorbed', 'count', 'Validated landed and absorbed observations are not available.'),
  unsupported('MVP-05', 'Offensive Efficiency', 'landed / active minutes', 'ratio', 'Validated landed and active-time observations are not available.'),
  unsupported('MVP-06', 'Contact Exposure', 'Σ(contact level × rounds) over 7 days; four-week weekly mean', 'au', 'Contact-level 0–3 observations and round exposure are not available.', true),
  unsupported('MVP-07', 'Work-Rate Consistency', '(sample SD of round output / mean round output) × 100', 'percent', 'Round-level output observations are not available.'),
  unsupported('MVP-08', 'Round-to-Round Change', 'outputₙ − outputₙ₋₁ and percentage change', 'unitless', 'Ordered round-level output observations are not available.'),
  unsupported('MVP-09', 'Personal Baseline Comparison', 'current − baseline; standardized change', 'unitless', 'Versioned immutable baseline snapshots and eligible observation-window rules are not yet persisted.', true),
  unsupported('MVP-10', 'Data Completeness and Confidence', 'present required fields / expected required fields', 'ratio', 'Metric-specific required-field schemas, source quality rules, and confidence policy are not yet approved.'),
  unsupported('MVP-11', 'Focus Attainment Rate', 'achieved eligible sessions / eligible sessions', 'percent', 'Eligible-session and achieved-focus observations are not available.'),
  unsupported('MVP-12', 'Seven-Day Weight Change', 'current measured weight − measured weight seven days earlier', 'unitless', 'Measured weight history does not exist; weight class text is not a weight measurement.', true),
  unsupported('BF-01', 'Combination Performance', 'combination rate; combination success rate', 'percent', 'Typed combination attempts, punches, and landed combinations are not available.'),
  unsupported('BF-02', 'Counterpunch Performance', 'counters / absorbed; counters landed / counters attempted', 'percent', 'Counter opportunities, attempts, landed counters, and absorbed punches are not available.'),
  unsupported('BF-03', 'Defensive Avoidance', '1 − absorbed / opponent attempts', 'ratio', 'Opponent attempts and validated absorbed-punch observations are not available.'),
  unsupported('BF-04', 'Power-Punch Performance', 'power attempts / total; power landed / power attempted', 'percent', 'Power-punch classifications, attempts, and landed observations are not available.'),
  unsupported('BF-05', 'Target Distribution', 'head-target share; body-target share', 'percent', 'Validated target-location observations are not available.'),
  unsupported('BF-06', 'Work:Rest Ratio', 'work seconds / rest seconds', 'ratio', 'Segmented work/rest timing observations are not available.'),
  unsupported('BF-07', 'Performance Decay', '(first-half mean − second-half mean) / first-half mean', 'ratio', 'Ordered session output observations and a session-halving policy are not available.'),
  unsupported('BF-08', 'Technical Quality Under Fatigue', 'primary technical-goal success rate in final session third', 'percent', 'Technical-goal opportunities/outcomes and ordered session segments are not available.'),
  unsupported('BF-09', 'Segmented Session Load', 'Σ(segment RPE × segment duration), grouped by segment type', 'au', 'Segment-level RPE, duration, and approved segment taxonomy are not available.'),
  unsupported('BF-10', 'Recommendation Priority', 'impact × confidence × completeness × recency, adjusted for research flags', 'unitless', 'Impact, confidence, recency, and research-flag weights are uncalibrated and not approved.', true),
  unsupported('BF-11', 'Personal Anomaly', '|standardized change| > versioned threshold', 'unitless', 'Immutable personal baselines and a calibrated versioned threshold are not available.', true),
  unsupported('BF-12', 'Guard Recovery', 'successful recoveries / opportunities or average recovery time', 'percent', 'Guard-recovery opportunities, outcomes, and timestamps are not available.'),
  unsupported('BF-13', 'Ring Control', 'center-time ratio or separately labeled coach ordinal observation', 'ratio', 'Center-zone tracking is unavailable and coach ordinal ratings must remain separately labeled observations.'),
  definition({
    id: 'LEGACY-READINESS',
    name: 'Legacy Readiness Equation',
    expression: 'clamp(1, 10, sleep × 1.25 − soreness × 0.45 + discipline × 0.3)',
    support: 'experimental_unsupported',
    outputUnit: 'unitless',
    humanReviewRequired: true,
    unsupportedReason: 'Coefficients, input scales, fairness, and clinical/safety validity are unproven. It must not clear, restrict, or prescribe training.',
  }),
]);

const formulaById = new Map<FormulaId, FormulaDefinition>(
  SHADOW_FORMULA_REGISTRY.map((item) => [item.id, item]),
);

if (formulaById.size !== FORMULA_IDS.length) {
  throw new Error('SHADOW formula registry contains a duplicate or missing formula ID.');
}

export function getFormulaDefinition(formulaId: FormulaId): FormulaDefinition {
  const result = formulaById.get(formulaId);
  if (!result) {
    throw new Error(`Unknown SHADOW formula ID: ${formulaId}`);
  }
  return result;
}
