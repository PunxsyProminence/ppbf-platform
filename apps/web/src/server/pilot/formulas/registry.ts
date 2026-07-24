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
  outputs?: FormulaDefinition['outputs'];
  requiredObservationKinds?: readonly ObservationKind[];
  humanReviewRequired?: boolean;
  unsupportedReason?: string;
  implementation?: string;
}

function definition(input: DefinitionInput): FormulaDefinition {
  const outputs = input.outputs ?? [{
    key: 'value',
    unit: input.outputUnit,
    description: input.name,
  }];
  return Object.freeze({
    ...input,
    version: '1.0.0',
    outputs: Object.freeze(outputs.map((output) => Object.freeze({ ...output }))),
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
  definition({
    id: 'MVP-02',
    name: 'Punch Output',
    expression: 'punches per round; punches / active minutes',
    support: 'implemented',
    outputUnit: 'ratio',
    outputs: [
      { key: 'punches_per_round', unit: 'ratio', description: 'Punches divided by completed rounds' },
      { key: 'punches_per_active_minute', unit: 'ratio', description: 'Punches divided by active minutes' },
    ],
    requiredObservationKinds: ['punch_count', 'round_count', 'active_time'],
    implementation: 'calculatePunchOutput',
  }),
  definition({
    id: 'MVP-03',
    name: 'Accuracy by Punch Type',
    expression: '(landed / attempted) × 100 by punch type',
    support: 'implemented',
    outputUnit: 'percent',
    requiredObservationKinds: ['punch_landed', 'punch_attempted'],
    implementation: 'calculateAccuracyByPunchType',
  }),
  definition({
    id: 'MVP-04',
    name: 'Connect Differential',
    expression: 'landed − absorbed',
    support: 'implemented',
    outputUnit: 'count',
    requiredObservationKinds: ['punch_landed', 'punch_absorbed'],
    implementation: 'calculateConnectDifferential',
  }),
  definition({
    id: 'MVP-05',
    name: 'Offensive Efficiency',
    expression: 'landed / active minutes',
    support: 'implemented',
    outputUnit: 'ratio',
    requiredObservationKinds: ['punch_landed', 'active_time'],
    implementation: 'calculateOffensiveEfficiency',
  }),
  definition({
    id: 'MVP-06',
    name: 'Contact Exposure',
    expression: 'Σ(contact level × rounds) over 7 days; four-week weekly mean',
    support: 'implemented',
    outputUnit: 'au',
    outputs: [
      { key: 'acute_7_day', unit: 'au', description: 'Seven-day contact exposure' },
      { key: 'chronic_4_week', unit: 'au', description: 'Mean of four weekly exposure totals' },
    ],
    requiredObservationKinds: ['contact_level', 'contact_rounds'],
    humanReviewRequired: true,
    implementation: 'calculateContactExposure',
  }),
  definition({
    id: 'MVP-07',
    name: 'Work-Rate Consistency',
    expression: '(sample SD of round output / mean round output) × 100',
    support: 'implemented',
    outputUnit: 'percent',
    requiredObservationKinds: ['round_output'],
    implementation: 'calculateWorkRateConsistency',
  }),
  definition({
    id: 'MVP-08',
    name: 'Round-to-Round Change',
    expression: 'outputₙ − outputₙ₋₁ and percentage change',
    support: 'implemented',
    outputUnit: 'unitless',
    outputs: [
      { key: 'raw_change', unit: 'input_unit', description: 'Current round output minus previous round output' },
      { key: 'percent_change', unit: 'percent', description: 'Raw change divided by previous round output' },
    ],
    requiredObservationKinds: ['round_output'],
    implementation: 'calculateRoundToRoundChange',
  }),
  definition({
    id: 'MVP-09',
    name: 'Personal Baseline Comparison',
    expression: 'current − baseline; standardized change',
    support: 'implemented',
    outputUnit: 'unitless',
    outputs: [
      { key: 'raw_change', unit: 'input_unit', description: 'Current value minus personal baseline mean' },
      { key: 'standardized_change', unit: 'ratio', description: 'Raw change divided by baseline sample SD' },
    ],
    requiredObservationKinds: ['numeric'],
    humanReviewRequired: true,
    implementation: 'calculatePersonalBaselineComparison',
  }),
  definition({
    id: 'MVP-10',
    name: 'Data Completeness and Confidence',
    expression: 'present required fields / expected required fields',
    support: 'implemented',
    outputUnit: 'ratio',
    requiredObservationKinds: ['numeric'],
    implementation: 'calculateDataCompleteness',
  }),
  definition({
    id: 'MVP-11',
    name: 'Focus Attainment Rate',
    expression: 'achieved eligible sessions / eligible sessions',
    support: 'implemented',
    outputUnit: 'percent',
    requiredObservationKinds: ['focus_achieved'],
    implementation: 'calculateFocusAttainmentRate',
  }),
  definition({
    id: 'MVP-12',
    name: 'Seven-Day Weight Change',
    expression: 'current measured weight − measured weight seven days earlier',
    support: 'implemented',
    outputUnit: 'unitless',
    outputs: [
      { key: 'weight_change', unit: 'input_unit', description: 'Current measured weight minus prior measured weight' },
    ],
    requiredObservationKinds: ['body_weight'],
    humanReviewRequired: true,
    implementation: 'calculateSevenDayWeightChange',
  }),
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
