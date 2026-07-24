import {
  acuteChronicWorkloadRatio,
  ewma,
  coefficientOfVariationPercent,
  percentageChange,
  rollingMean,
  sampleStandardDeviation,
  mean,
  standardizedChange,
} from './primitives';
import { deterministicKey } from './identity';
import { getFormulaDefinition } from './registry';
import type {
  ConfidenceState,
  FormulaId,
  FormulaResult,
  FormulaUnit,
  NumericObservation,
  ProvenanceSnapshot,
  SourceQuality,
  ValidationReasonCode,
  ValidationState,
} from './types';

type SessionLoadFormulaId = 'CORE-01' | 'MVP-01';

interface ResultInput {
  formulaId: FormulaId;
  observations: readonly NumericObservation[];
  outputKey?: string;
  policyVersion?: string;
  parameters?: Readonly<Record<string, unknown>>;
  value: number | null;
  unit?: FormulaUnit;
  state: ValidationState;
  hardBlocks?: readonly ValidationReasonCode[];
  warnings?: readonly ValidationReasonCode[];
  unavailableReason?: ValidationReasonCode | null;
  completenessOverride?: number;
  confidenceOverride?: ConfidenceState;
  computedAt?: string;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      const child = (value as Record<string, unknown>)[key];
      deepFreeze(child);
    }
  }
  return value;
}

function deduplicate<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function worstSourceQuality(observations: readonly NumericObservation[]): SourceQuality | null {
  if (observations.length === 0) return null;
  const order: Record<SourceQuality, number> = {
    verified: 0,
    high: 1,
    moderate: 2,
    low: 3,
    failed: 4,
  };
  return observations
    .map((observation) => observation.source.quality)
    .sort((left, right) => order[right] - order[left])[0];
}

function confidenceFor(
  state: ValidationState,
  worstQuality: SourceQuality | null,
  warnings: readonly ValidationReasonCode[],
): ConfidenceState {
  if (state === 'invalid' || state === 'insufficient' || state === 'unsupported') {
    return 'INSUFFICIENT';
  }
  if (worstQuality === 'low' || warnings.includes('SOURCE_QUALITY_WARNING')) {
    return 'LOW';
  }
  if (
    worstQuality === 'moderate'
    || warnings.includes('FALLBACK_SOURCE_USED')
    || state === 'warning'
  ) {
    return 'MODERATE';
  }
  return 'HIGH';
}

function snapshotProvenance(observation: NumericObservation): ProvenanceSnapshot {
  return Object.freeze({
    observationId: observation.observationId,
    kind: observation.kind,
    unit: observation.unit,
    observedAt: observation.observedAt,
    sourceType: observation.source.type,
    sourceQuality: observation.source.quality,
    sourceReferenceId: observation.source.referenceId,
    dimensions: Object.freeze({ ...(observation.dimensions ?? {}) }),
  });
}

function makeResult(input: ResultInput): FormulaResult {
  const definition = getFormulaDefinition(input.formulaId);
  const hardBlocks = deduplicate(input.hardBlocks ?? []);
  const warnings = deduplicate(input.warnings ?? []);
  const valuesPresent = input.observations.filter((observation) => observation.value != null).length;
  const observedCompleteness = input.observations.length === 0
    ? 0
    : valuesPresent / input.observations.length;
  const completeness = input.completenessOverride === undefined
    ? observedCompleteness
    : Math.max(0, Math.min(1, input.completenessOverride));
  const worstQuality = worstSourceQuality(input.observations);
  const computedAt = input.computedAt ?? new Date().toISOString();
  const computedAtIsValid = Number.isFinite(Date.parse(computedAt));
  if (!computedAtIsValid) {
    hardBlocks.push('INVALID_TIMESTAMP');
  }
  const effectiveHardBlocks = deduplicate(hardBlocks);
  const effectiveState = computedAtIsValid ? input.state : 'invalid';
  const effectiveValue = computedAtIsValid ? input.value : null;
  const effectiveUnavailableReason = computedAtIsValid
    ? (input.unavailableReason ?? null)
    : 'INVALID_TIMESTAMP';
  const organizationIds = deduplicate(input.observations.map((item) => item.organizationId));
  const athleteIds = deduplicate(input.observations.map((item) => item.athleteId));
  const contextIds = deduplicate(input.observations.map((item) => item.contextId));
  const outputKey = input.outputKey ?? definition.outputs[0]?.key ?? 'value';
  const policyVersion = input.policyVersion ?? definition.version;
  const parameters = Object.freeze({ ...(input.parameters ?? {}) });
  const calculationKey = deterministicKey('formula', {
    formulaId: input.formulaId,
    formulaVersion: definition.version,
    outputKey,
    policyVersion,
    parameters,
    organizationIds,
    athleteIds,
    contextIds,
    inputObservationIds: input.observations.map((item) => item.observationId),
  });

  return deepFreeze({
    resultId: calculationKey,
    calculationKey,
    formulaId: input.formulaId,
    formulaVersion: definition.version,
    outputKey,
    policyVersion,
    parameters,
    organizationId: organizationIds.length === 1 ? organizationIds[0] : null,
    athleteId: athleteIds.length === 1 ? athleteIds[0] : null,
    contextId: contextIds.length === 1 ? contextIds[0] : null,
    value: effectiveValue,
    unit: input.unit ?? definition.outputUnit,
    computedAt,
    inputObservationIds: input.observations.map((item) => item.observationId),
    provenance: input.observations.map(snapshotProvenance),
    validation: {
      state: effectiveState,
      hardBlocks: effectiveHardBlocks,
      warnings,
    },
    quality: {
      confidence: effectiveState === 'invalid'
        || effectiveState === 'insufficient'
        || effectiveState === 'unsupported'
        ? 'INSUFFICIENT'
        : (input.confidenceOverride ?? confidenceFor(effectiveState, worstQuality, warnings)),
      completeness,
      worstSourceQuality: worstQuality,
    },
    unavailableReason: effectiveUnavailableReason,
    humanReviewRequired: definition.humanReviewRequired,
  });
}

function commonValidation(
  observations: readonly NumericObservation[],
  options: { requireSameContext?: boolean } = {},
): {
  hardBlocks: ValidationReasonCode[];
  warnings: ValidationReasonCode[];
} {
  const hardBlocks: ValidationReasonCode[] = [];
  const warnings: ValidationReasonCode[] = [];

  if (new Set(observations.map((item) => item.organizationId)).size > 1) {
    hardBlocks.push('ORGANIZATION_SCOPE_MISMATCH');
  }
  if (new Set(observations.map((item) => item.athleteId)).size > 1) {
    hardBlocks.push('ATHLETE_SCOPE_MISMATCH');
  }
  if (
    options.requireSameContext !== false
    && new Set(observations.map((item) => item.contextId)).size > 1
  ) {
    hardBlocks.push('CONTEXT_MISMATCH');
  }

  for (const observation of observations) {
    if (!Number.isFinite(Date.parse(observation.observedAt))) {
      hardBlocks.push('INVALID_TIMESTAMP');
    }
    if (observation.source.quality === 'failed') {
      hardBlocks.push('SOURCE_QUALITY_FAIL');
    } else if (observation.source.quality === 'low') {
      warnings.push('SOURCE_QUALITY_WARNING');
    }
    if (
      observation.source.type === 'manual'
      || observation.source.type === 'coach_tag'
      || observation.source.type === 'imported'
    ) {
      warnings.push('FALLBACK_SOURCE_USED');
    }
    if (observation.value != null && !Number.isFinite(observation.value)) {
      hardBlocks.push('NON_FINITE_VALUE');
    }
  }

  return {
    hardBlocks: deduplicate(hardBlocks),
    warnings: deduplicate(warnings),
  };
}

function stateFor(hardBlocks: readonly ValidationReasonCode[], warnings: readonly ValidationReasonCode[]): ValidationState {
  if (hardBlocks.length > 0) return 'invalid';
  if (warnings.length > 0) return 'warning';
  return 'valid';
}

function firstHardBlock(
  hardBlocks: readonly ValidationReasonCode[],
  fallback: ValidationReasonCode = 'INSUFFICIENT_DATA',
): ValidationReasonCode {
  return hardBlocks[0] ?? fallback;
}

function isChronological(observations: readonly NumericObservation[]): boolean {
  for (let index = 1; index < observations.length; index += 1) {
    if (Date.parse(observations[index].observedAt) < Date.parse(observations[index - 1].observedAt)) {
      return false;
    }
  }
  return true;
}

export function calculateSessionLoad(input: {
  rpe: NumericObservation<'session_rpe', 'rpe_0_10'>;
  duration: NumericObservation<'duration', 'minutes'>;
  formulaId?: SessionLoadFormulaId;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.rpe, input.duration] as const;
  const validation = commonValidation(observations);

  if (input.rpe.kind !== 'session_rpe') validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  if (input.duration.kind !== 'duration') validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  if (input.rpe.unit !== 'rpe_0_10' || input.duration.unit !== 'minutes') {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.rpe.value == null) {
    const hardBlocks = deduplicate<ValidationReasonCode>([
      ...validation.hardBlocks,
      'MISSING_RPE',
    ]);
    return makeResult({
      formulaId: input.formulaId ?? 'MVP-01',
      observations,
      value: null,
      state: 'insufficient',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: 'MISSING_RPE',
      computedAt: input.computedAt,
    });
  }
  if (input.duration.value == null) {
    const hardBlocks = deduplicate<ValidationReasonCode>([
      ...validation.hardBlocks,
      'MISSING_DURATION',
    ]);
    return makeResult({
      formulaId: input.formulaId ?? 'MVP-01',
      observations,
      value: null,
      state: 'insufficient',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: 'MISSING_DURATION',
      computedAt: input.computedAt,
    });
  }
  if (input.rpe.value < 0 || input.rpe.value > 10) {
    validation.hardBlocks.push('RPE_OUT_OF_RANGE');
  }
  if (input.duration.value <= 0) {
    validation.hardBlocks.push('ZERO_ACTIVE_TIME');
  }

  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: input.formulaId ?? 'MVP-01',
      observations,
      value: null,
      state: 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }

  const value = input.rpe.value * input.duration.value;
  if (!Number.isFinite(value)) {
    return makeResult({
      formulaId: input.formulaId ?? 'MVP-01',
      observations,
      value: null,
      state: 'invalid',
      hardBlocks: ['NON_FINITE_VALUE'],
      warnings: validation.warnings,
      unavailableReason: 'NON_FINITE_VALUE',
      computedAt: input.computedAt,
    });
  }

  return makeResult({
    formulaId: input.formulaId ?? 'MVP-01',
    observations,
    value,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function calculateAttendanceRate(input: {
  scheduled: NumericObservation<'scheduled_sessions', 'count'>;
  attended: NumericObservation<'attended_sessions', 'count'>;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.scheduled, input.attended] as const;
  const validation = commonValidation(observations);

  if (input.scheduled.kind !== 'scheduled_sessions' || input.attended.kind !== 'attended_sessions') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (input.scheduled.unit !== 'count' || input.attended.unit !== 'count') {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.scheduled.value == null || input.attended.value == null) {
    const hardBlocks = deduplicate<ValidationReasonCode>([
      ...validation.hardBlocks,
      'INSUFFICIENT_DATA',
    ]);
    return makeResult({
      formulaId: 'CORE-02',
      observations,
      value: null,
      state: 'insufficient',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: 'INSUFFICIENT_DATA',
      computedAt: input.computedAt,
    });
  }
  if (input.scheduled.value < 0 || input.attended.value < 0) {
    validation.hardBlocks.push('NEGATIVE_VALUE');
  }
  if (!Number.isInteger(input.scheduled.value) || !Number.isInteger(input.attended.value)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  if (input.scheduled.value === 0) {
    validation.hardBlocks.push('DIV_BY_ZERO');
  }
  if (input.attended.value > input.scheduled.value) {
    validation.hardBlocks.push('ATTENDED_GT_SCHEDULED');
  }

  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'CORE-02',
      observations,
      value: null,
      state: hardBlocks.includes('DIV_BY_ZERO') ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }

  return makeResult({
    formulaId: 'CORE-02',
    observations,
    value: (input.attended.value / input.scheduled.value) * 100,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

function validateLoadSeries(
  observations: readonly NumericObservation<'session_load', 'au'>[],
): {
  hardBlocks: ValidationReasonCode[];
  warnings: ValidationReasonCode[];
  values: number[];
} {
  const validation = commonValidation(observations, { requireSameContext: false });
  if (observations.length === 0) {
    validation.hardBlocks.push('INSUFFICIENT_DATA');
  }
  if (!isChronological(observations)) {
    validation.hardBlocks.push('OBSERVATIONS_NOT_CHRONOLOGICAL');
  }
  for (const observation of observations) {
    if (observation.kind !== 'session_load') validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
    if (observation.unit !== 'au') validation.hardBlocks.push('UNIT_MISMATCH');
    if (observation.value == null) validation.hardBlocks.push('INSUFFICIENT_DATA');
    if (observation.value != null && observation.value < 0) validation.hardBlocks.push('NEGATIVE_VALUE');
  }
  return {
    hardBlocks: deduplicate(validation.hardBlocks),
    warnings: validation.warnings,
    values: observations.flatMap((observation) => observation.value == null ? [] : [observation.value]),
  };
}

export function calculateRollingLoad(input: {
  loads: readonly NumericObservation<'session_load', 'au'>[];
  window: number;
  computedAt?: string;
}): FormulaResult {
  const validation = validateLoadSeries(input.loads);
  if (validation.hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'CORE-11',
      observations: input.loads,
      value: null,
      state: validation.hardBlocks.includes('INSUFFICIENT_DATA') ? 'insufficient' : 'invalid',
      hardBlocks: validation.hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(validation.hardBlocks),
      computedAt: input.computedAt,
    });
  }
  const outcome = rollingMean(validation.values, input.window);
  if (!outcome.ok) {
    return makeResult({
      formulaId: 'CORE-11',
      observations: input.loads,
      value: null,
      state: outcome.reason === 'INSUFFICIENT_HISTORY' ? 'insufficient' : 'invalid',
      hardBlocks: [outcome.reason],
      warnings: validation.warnings,
      unavailableReason: outcome.reason,
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'CORE-11',
    observations: input.loads,
    value: outcome.value,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function calculateEwmaLoad(input: {
  loads: readonly NumericObservation<'session_load', 'au'>[];
  lambda: number;
  computedAt?: string;
}): FormulaResult {
  const validation = validateLoadSeries(input.loads);
  if (validation.hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'CORE-12',
      observations: input.loads,
      value: null,
      state: validation.hardBlocks.includes('INSUFFICIENT_DATA') ? 'insufficient' : 'invalid',
      hardBlocks: validation.hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(validation.hardBlocks),
      computedAt: input.computedAt,
    });
  }
  const outcome = ewma(validation.values, input.lambda);
  if (!outcome.ok) {
    return makeResult({
      formulaId: 'CORE-12',
      observations: input.loads,
      value: null,
      state: outcome.reason === 'INSUFFICIENT_DATA' ? 'insufficient' : 'invalid',
      hardBlocks: [outcome.reason],
      warnings: validation.warnings,
      unavailableReason: outcome.reason,
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'CORE-12',
    observations: input.loads,
    value: outcome.value,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function calculateAcuteChronicWorkloadRatio(input: {
  acute: NumericObservation<'acute_load', 'au'>;
  chronic: NumericObservation<'chronic_load', 'au'>;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.acute, input.chronic] as const;
  const validation = commonValidation(observations);
  if (input.acute.kind !== 'acute_load' || input.chronic.kind !== 'chronic_load') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (input.acute.unit !== 'au' || input.chronic.unit !== 'au') {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.acute.value == null || input.chronic.value == null) {
    validation.hardBlocks.push('INSUFFICIENT_DATA');
  }

  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'CORE-13',
      observations,
      value: null,
      state: hardBlocks.includes('INSUFFICIENT_DATA') ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }

  const outcome = acuteChronicWorkloadRatio(input.acute.value!, input.chronic.value!);
  if (!outcome.ok) {
    return makeResult({
      formulaId: 'CORE-13',
      observations,
      value: null,
      state: outcome.reason === 'ZERO_CHRONIC_LOAD' ? 'insufficient' : 'invalid',
      hardBlocks: [outcome.reason],
      warnings: validation.warnings,
      unavailableReason: outcome.reason,
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'CORE-13',
    observations,
    value: outcome.value,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

interface OutputSpec {
  outputKey: string;
  unit: FormulaUnit;
}

function unavailableResults(input: {
  formulaId: FormulaId;
  observations: readonly NumericObservation[];
  outputs: readonly OutputSpec[];
  state: ValidationState;
  hardBlocks: readonly ValidationReasonCode[];
  warnings?: readonly ValidationReasonCode[];
  unavailableReason?: ValidationReasonCode;
  policyVersion?: string;
  parameters?: Readonly<Record<string, unknown>>;
  computedAt?: string;
}): readonly FormulaResult[] {
  return Object.freeze(input.outputs.map((output) => makeResult({
    formulaId: input.formulaId,
    observations: input.observations,
    outputKey: output.outputKey,
    unit: output.unit,
    policyVersion: input.policyVersion,
    parameters: input.parameters,
    value: null,
    state: input.state,
    hardBlocks: input.hardBlocks,
    warnings: input.warnings,
    unavailableReason: input.unavailableReason ?? firstHardBlock(input.hardBlocks),
    computedAt: input.computedAt,
  })));
}

function policyVersionIsValid(policyVersion: string): boolean {
  return policyVersion.trim().length > 0 && policyVersion.length <= 120;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function dimensionString(observation: NumericObservation, key: string): string | null {
  const value = observation.dimensions?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dimensionNumber(observation: NumericObservation, key: string): number | null {
  const value = observation.dimensions?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function calculatePunchOutput(input: {
  punches: NumericObservation<'punch_count', 'count'>;
  rounds: NumericObservation<'round_count', 'count'>;
  activeTime: NumericObservation<'active_time', 'minutes'>;
  computedAt?: string;
}): readonly FormulaResult[] {
  const observations = [input.punches, input.rounds, input.activeTime] as const;
  const outputs: readonly OutputSpec[] = [
    { outputKey: 'punches_per_round', unit: 'ratio' },
    { outputKey: 'punches_per_active_minute', unit: 'ratio' },
  ];
  const validation = commonValidation(observations);
  if (
    input.punches.kind !== 'punch_count'
    || input.rounds.kind !== 'round_count'
    || input.activeTime.kind !== 'active_time'
  ) {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (
    input.punches.unit !== 'count'
    || input.rounds.unit !== 'count'
    || input.activeTime.unit !== 'minutes'
  ) {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.punches.value == null) validation.hardBlocks.push('MISSING_PUNCH_COUNT');
  if (input.rounds.value == null) validation.hardBlocks.push('MISSING_ROUNDS');
  if (input.activeTime.value == null) validation.hardBlocks.push('MISSING_ACTIVE_TIME');
  if (validation.hardBlocks.length > 0) {
    const hardBlocks = deduplicate(validation.hardBlocks);
    return unavailableResults({
      formulaId: 'MVP-02',
      observations,
      outputs,
      state: hardBlocks.some((reason) => reason.startsWith('MISSING_')) ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      computedAt: input.computedAt,
    });
  }
  if (!nonNegativeInteger(input.punches.value!) || !Number.isInteger(input.rounds.value!)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  if (input.rounds.value! <= 0 || input.activeTime.value! <= 0) {
    validation.hardBlocks.push('ZERO_ACTIVE_TIME');
  }
  if (input.punches.value! < 0 || input.activeTime.value! < 0) {
    validation.hardBlocks.push('NEGATIVE_VALUE');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return unavailableResults({
      formulaId: 'MVP-02',
      observations,
      outputs,
      state: hardBlocks.includes('ZERO_ACTIVE_TIME') ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      computedAt: input.computedAt,
    });
  }
  return deepFreeze([
    makeResult({
      formulaId: 'MVP-02',
      observations,
      outputKey: 'punches_per_round',
      value: input.punches.value! / input.rounds.value!,
      unit: 'ratio',
      state: stateFor([], validation.warnings),
      warnings: validation.warnings,
      computedAt: input.computedAt,
    }),
    makeResult({
      formulaId: 'MVP-02',
      observations,
      outputKey: 'punches_per_active_minute',
      value: input.punches.value! / input.activeTime.value!,
      unit: 'ratio',
      state: stateFor([], validation.warnings),
      warnings: validation.warnings,
      computedAt: input.computedAt,
    }),
  ]);
}

export function calculateAccuracyByPunchType(input: {
  landed: NumericObservation<'punch_landed', 'count'>;
  attempted: NumericObservation<'punch_attempted', 'count'>;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.landed, input.attempted] as const;
  const validation = commonValidation(observations);
  const landedType = dimensionString(input.landed, 'punchType');
  const attemptedType = dimensionString(input.attempted, 'punchType');
  if (input.landed.kind !== 'punch_landed' || input.attempted.kind !== 'punch_attempted') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (input.landed.unit !== 'count' || input.attempted.unit !== 'count') {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (!landedType || !attemptedType) validation.hardBlocks.push('INVALID_DIMENSION');
  if (landedType && attemptedType && landedType !== attemptedType) {
    validation.hardBlocks.push('DIMENSION_MISMATCH');
  }
  if (input.landed.value == null) validation.hardBlocks.push('MISSING_LANDED');
  if (input.attempted.value == null) validation.hardBlocks.push('MISSING_ATTEMPTED');
  if (input.landed.value != null && !nonNegativeInteger(input.landed.value)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  if (input.attempted.value != null && !nonNegativeInteger(input.attempted.value)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  if (input.attempted.value === 0) validation.hardBlocks.push('ZERO_ATTEMPTS');
  if (
    input.landed.value != null
    && input.attempted.value != null
    && input.landed.value > input.attempted.value
  ) {
    validation.hardBlocks.push('LANDED_GT_ATTEMPTED');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  const outputKey = landedType
    ? `accuracy_${landedType.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80)}`
    : 'accuracy_unknown';
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-03',
      observations,
      outputKey,
      parameters: { punchType: landedType },
      value: null,
      unit: 'percent',
      state: hardBlocks.some((reason) => reason.startsWith('MISSING_') || reason === 'ZERO_ATTEMPTS')
        ? 'insufficient'
        : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'MVP-03',
    observations,
    outputKey,
    parameters: { punchType: landedType },
    value: (input.landed.value! / input.attempted.value!) * 100,
    unit: 'percent',
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function calculateConnectDifferential(input: {
  landed: NumericObservation<'punch_landed', 'count'>;
  absorbed: NumericObservation<'punch_absorbed', 'count'>;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.landed, input.absorbed] as const;
  const validation = commonValidation(observations);
  if (input.landed.kind !== 'punch_landed' || input.absorbed.kind !== 'punch_absorbed') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (input.landed.unit !== 'count' || input.absorbed.unit !== 'count') {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.landed.value == null) validation.hardBlocks.push('MISSING_LANDED');
  if (input.absorbed.value == null) validation.hardBlocks.push('MISSING_ABSORBED');
  if (input.landed.value != null && !nonNegativeInteger(input.landed.value)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  if (input.absorbed.value != null && !nonNegativeInteger(input.absorbed.value)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-04',
      observations,
      value: null,
      state: hardBlocks.some((reason) => reason.startsWith('MISSING_')) ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'MVP-04',
    observations,
    value: input.landed.value! - input.absorbed.value!,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function calculateOffensiveEfficiency(input: {
  landed: NumericObservation<'punch_landed', 'count'>;
  activeTime: NumericObservation<'active_time', 'minutes'>;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.landed, input.activeTime] as const;
  const validation = commonValidation(observations);
  if (input.landed.kind !== 'punch_landed' || input.activeTime.kind !== 'active_time') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (input.landed.unit !== 'count' || input.activeTime.unit !== 'minutes') {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.landed.value == null) validation.hardBlocks.push('MISSING_LANDED');
  if (input.activeTime.value == null) validation.hardBlocks.push('MISSING_ACTIVE_TIME');
  if (input.landed.value != null && !nonNegativeInteger(input.landed.value)) {
    validation.hardBlocks.push('NON_INTEGER_COUNT');
  }
  if (input.activeTime.value != null && input.activeTime.value <= 0) {
    validation.hardBlocks.push('ZERO_ACTIVE_TIME');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-05',
      observations,
      value: null,
      state: hardBlocks.some((reason) => reason.startsWith('MISSING_') || reason === 'ZERO_ACTIVE_TIME')
        ? 'insufficient'
        : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'MVP-05',
    observations,
    value: input.landed.value! / input.activeTime.value!,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export interface ContactExposurePolicy {
  readonly asOf: string;
  readonly acuteDays: 7;
  readonly chronicWeeks: 4;
  /**
   * True only when the caller can distinguish a zero-exposure week from a
   * missing-data week. SHADOW never manufactures zero exposure.
   */
  readonly coverageComplete: boolean;
}

export function calculateContactExposure(input: {
  sessions: readonly {
    level: NumericObservation<'contact_level', 'level_0_3'>;
    rounds: NumericObservation<'contact_rounds', 'count'>;
  }[];
  policy: ContactExposurePolicy;
  policyVersion: string;
  computedAt?: string;
}): readonly FormulaResult[] {
  const observations = input.sessions.flatMap((session) => [session.level, session.rounds]);
  const outputs: readonly OutputSpec[] = [
    { outputKey: 'acute_7_day', unit: 'au' },
    { outputKey: 'chronic_4_week', unit: 'au' },
  ];
  const parameters = {
    asOf: input.policy.asOf,
    acuteDays: input.policy.acuteDays,
    chronicWeeks: input.policy.chronicWeeks,
    coverageComplete: input.policy.coverageComplete,
  };
  const validation = commonValidation(observations, { requireSameContext: false });
  const asOfMs = Date.parse(input.policy.asOf);
  if (
    !policyVersionIsValid(input.policyVersion)
    || input.policy.acuteDays !== 7
    || input.policy.chronicWeeks !== 4
    || !Number.isFinite(asOfMs)
  ) {
    validation.hardBlocks.push('INVALID_POLICY');
  }
  if (!input.policy.coverageComplete) validation.hardBlocks.push('INCOMPLETE_WINDOW');
  if (input.sessions.length === 0) validation.hardBlocks.push('INSUFFICIENT_DATA');
  const windowMs = 7 * 24 * 60 * 60 * 1_000;
  const oldestAllowed = asOfMs - (4 * windowMs);
  for (const session of input.sessions) {
    const pairValidation = commonValidation([session.level, session.rounds]);
    validation.hardBlocks.push(...pairValidation.hardBlocks);
    validation.warnings.push(...pairValidation.warnings);
    if (session.level.kind !== 'contact_level' || session.rounds.kind !== 'contact_rounds') {
      validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
    }
    if (session.level.unit !== 'level_0_3' || session.rounds.unit !== 'count') {
      validation.hardBlocks.push('UNIT_MISMATCH');
    }
    if (session.level.value == null) validation.hardBlocks.push('MISSING_CONTACT_LEVEL');
    if (session.rounds.value == null) validation.hardBlocks.push('MISSING_ROUNDS');
    if (
      session.level.value != null
      && (!Number.isInteger(session.level.value) || session.level.value < 0 || session.level.value > 3)
    ) {
      validation.hardBlocks.push('INVALID_CONTACT_LEVEL');
    }
    if (
      session.rounds.value != null
      && (!Number.isInteger(session.rounds.value) || session.rounds.value <= 0)
    ) {
      validation.hardBlocks.push('NON_INTEGER_COUNT');
    }
    const observedMs = Date.parse(session.level.observedAt);
    if (
      Number.isFinite(asOfMs)
      && (!Number.isFinite(observedMs) || observedMs > asOfMs || observedMs <= oldestAllowed)
    ) {
      validation.hardBlocks.push('DATE_WINDOW_MISMATCH');
    }
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return unavailableResults({
      formulaId: 'MVP-06',
      observations,
      outputs,
      state: hardBlocks.some((reason) => (
        reason.startsWith('MISSING_')
        || reason === 'INSUFFICIENT_DATA'
        || reason === 'INCOMPLETE_WINDOW'
      )) ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: deduplicate(validation.warnings),
      policyVersion: input.policyVersion,
      parameters,
      computedAt: input.computedAt,
    });
  }
  const weeklyTotals = [0, 0, 0, 0];
  for (const session of input.sessions) {
    const ageMs = asOfMs - Date.parse(session.level.observedAt);
    const weekIndex = Math.min(3, Math.floor(ageMs / windowMs));
    weeklyTotals[weekIndex] += session.level.value! * session.rounds.value!;
  }
  const warnings = deduplicate(validation.warnings);
  return deepFreeze([
    makeResult({
      formulaId: 'MVP-06',
      observations,
      outputKey: 'acute_7_day',
      policyVersion: input.policyVersion,
      parameters,
      value: weeklyTotals[0],
      unit: 'au',
      state: stateFor([], warnings),
      warnings,
      computedAt: input.computedAt,
    }),
    makeResult({
      formulaId: 'MVP-06',
      observations,
      outputKey: 'chronic_4_week',
      policyVersion: input.policyVersion,
      parameters,
      value: weeklyTotals.reduce((sum, value) => sum + value, 0) / 4,
      unit: 'au',
      state: stateFor([], warnings),
      warnings,
      computedAt: input.computedAt,
    }),
  ]);
}

export function calculateWorkRateConsistency(input: {
  rounds: readonly NumericObservation<'round_output'>[];
  computedAt?: string;
}): FormulaResult {
  const validation = commonValidation(input.rounds);
  if (input.rounds.length < 2) validation.hardBlocks.push('INSUFFICIENT_ROUNDS');
  const units = new Set(input.rounds.map((round) => round.unit));
  if (units.size > 1) validation.hardBlocks.push('UNIT_MISMATCH');
  const roundNumbers: number[] = [];
  for (const round of input.rounds) {
    if (round.kind !== 'round_output') validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
    if (round.value == null) validation.hardBlocks.push('INSUFFICIENT_DATA');
    if (round.value != null && round.value < 0) validation.hardBlocks.push('NEGATIVE_VALUE');
    const roundNumber = dimensionNumber(round, 'round');
    if (!roundNumber || !Number.isInteger(roundNumber) || roundNumber < 1) {
      validation.hardBlocks.push('INVALID_DIMENSION');
    } else {
      roundNumbers.push(roundNumber);
    }
  }
  if (
    roundNumbers.length === input.rounds.length
    && (new Set(roundNumbers).size !== roundNumbers.length
      || roundNumbers.some((value, index) => index > 0 && value <= roundNumbers[index - 1]))
  ) {
    validation.hardBlocks.push('DIMENSION_MISMATCH');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-07',
      observations: input.rounds,
      value: null,
      state: hardBlocks.includes('INSUFFICIENT_ROUNDS') || hardBlocks.includes('INSUFFICIENT_DATA')
        ? 'insufficient'
        : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  const outcome = coefficientOfVariationPercent(input.rounds.map((round) => round.value!));
  if (!outcome.ok) {
    return makeResult({
      formulaId: 'MVP-07',
      observations: input.rounds,
      value: null,
      state: outcome.reason === 'ZERO_MEAN' ? 'insufficient' : 'invalid',
      hardBlocks: [outcome.reason],
      warnings: validation.warnings,
      unavailableReason: outcome.reason,
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'MVP-07',
    observations: input.rounds,
    value: outcome.value,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function calculateRoundToRoundChange(input: {
  previous: NumericObservation<'round_output'>;
  current: NumericObservation<'round_output'>;
  computedAt?: string;
}): readonly FormulaResult[] {
  const observations = [input.previous, input.current] as const;
  const outputs: readonly OutputSpec[] = [
    { outputKey: 'raw_change', unit: input.current.unit },
    { outputKey: 'percent_change', unit: 'percent' },
  ];
  const validation = commonValidation(observations);
  if (input.previous.kind !== 'round_output' || input.current.kind !== 'round_output') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (input.previous.unit !== input.current.unit) validation.hardBlocks.push('UNIT_MISMATCH');
  if (input.previous.value == null || input.current.value == null) {
    validation.hardBlocks.push('INSUFFICIENT_DATA');
  }
  if ((input.previous.value ?? 0) < 0 || (input.current.value ?? 0) < 0) {
    validation.hardBlocks.push('NEGATIVE_VALUE');
  }
  const previousRound = dimensionNumber(input.previous, 'round');
  const currentRound = dimensionNumber(input.current, 'round');
  if (!previousRound || !currentRound) {
    validation.hardBlocks.push('INVALID_DIMENSION');
  } else if (currentRound !== previousRound + 1) {
    validation.hardBlocks.push('DIMENSION_MISMATCH');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return unavailableResults({
      formulaId: 'MVP-08',
      observations,
      outputs,
      state: hardBlocks.includes('INSUFFICIENT_DATA') ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      computedAt: input.computedAt,
    });
  }
  const rawChange = input.current.value! - input.previous.value!;
  const percentOutcome = percentageChange(input.current.value!, input.previous.value!);
  const rawResult = makeResult({
    formulaId: 'MVP-08',
    observations,
    outputKey: 'raw_change',
    value: rawChange,
    unit: input.current.unit,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
  const percentResult = percentOutcome.ok
    ? makeResult({
        formulaId: 'MVP-08',
        observations,
        outputKey: 'percent_change',
        value: percentOutcome.value,
        unit: 'percent',
        state: stateFor([], validation.warnings),
        warnings: validation.warnings,
        computedAt: input.computedAt,
      })
    : makeResult({
        formulaId: 'MVP-08',
        observations,
        outputKey: 'percent_change',
        value: null,
        unit: 'percent',
        state: 'insufficient',
        hardBlocks: [percentOutcome.reason],
        warnings: validation.warnings,
        unavailableReason: percentOutcome.reason,
        computedAt: input.computedAt,
      });
  return deepFreeze([rawResult, percentResult]);
}

export interface PersonalBaselinePolicy {
  readonly metricKey: string;
  readonly windowSize: number;
  readonly minimumHistory: 4;
  readonly adequateHistory: number;
}

export function calculatePersonalBaselineComparison(input: {
  current: NumericObservation<'numeric'>;
  history: readonly NumericObservation<'numeric'>[];
  policy: PersonalBaselinePolicy;
  policyVersion: string;
  computedAt?: string;
}): readonly FormulaResult[] {
  const selectedHistory = input.history.slice(-input.policy.windowSize);
  const observations = [...selectedHistory, input.current];
  const outputs: readonly OutputSpec[] = [
    { outputKey: 'raw_change', unit: input.current.unit },
    { outputKey: 'standardized_change', unit: 'ratio' },
  ];
  const parameters = {
    metricKey: input.policy.metricKey,
    windowSize: input.policy.windowSize,
    minimumHistory: input.policy.minimumHistory,
    adequateHistory: input.policy.adequateHistory,
  };
  const validation = commonValidation(observations, { requireSameContext: false });
  if (
    !policyVersionIsValid(input.policyVersion)
    || !input.policy.metricKey.trim()
    || !Number.isInteger(input.policy.windowSize)
    || input.policy.windowSize < 8
    || input.policy.windowSize > 12
    || input.policy.minimumHistory !== 4
    || !Number.isInteger(input.policy.adequateHistory)
    || input.policy.adequateHistory < 8
    || input.policy.adequateHistory > input.policy.windowSize
  ) {
    validation.hardBlocks.push('INVALID_POLICY');
  }
  for (const observation of observations) {
    if (observation.kind !== 'numeric') validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
    if (observation.unit !== input.current.unit) validation.hardBlocks.push('UNIT_MISMATCH');
    if (dimensionString(observation, 'metricKey') !== input.policy.metricKey) {
      validation.hardBlocks.push('DIMENSION_MISMATCH');
    }
    if (observation.value == null) validation.hardBlocks.push('INSUFFICIENT_DATA');
  }
  if (!isChronological(selectedHistory)) {
    validation.hardBlocks.push('OBSERVATIONS_NOT_CHRONOLOGICAL');
  }
  if (
    selectedHistory.some((observation) => Date.parse(observation.observedAt) >= Date.parse(input.current.observedAt))
  ) {
    validation.hardBlocks.push('OBSERVATIONS_NOT_CHRONOLOGICAL');
  }
  if (selectedHistory.length < input.policy.minimumHistory) {
    validation.hardBlocks.push('INSUFFICIENT_HISTORY');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return unavailableResults({
      formulaId: 'MVP-09',
      observations,
      outputs,
      state: hardBlocks.includes('INSUFFICIENT_HISTORY') || hardBlocks.includes('INSUFFICIENT_DATA')
        ? 'insufficient'
        : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      policyVersion: input.policyVersion,
      parameters,
      computedAt: input.computedAt,
    });
  }
  const values = selectedHistory.map((observation) => observation.value!);
  const baselineMean = mean(values);
  const baselineSd = sampleStandardDeviation(values);
  if (!baselineMean.ok || !baselineSd.ok) {
    const reason = !baselineMean.ok ? baselineMean.reason : (baselineSd as { ok: false; reason: ValidationReasonCode }).reason;
    return unavailableResults({
      formulaId: 'MVP-09',
      observations,
      outputs,
      state: reason === 'INSUFFICIENT_HISTORY' ? 'insufficient' : 'invalid',
      hardBlocks: [reason],
      warnings: validation.warnings,
      policyVersion: input.policyVersion,
      parameters,
      computedAt: input.computedAt,
    });
  }
  const warnings = selectedHistory.length < input.policy.adequateHistory
    ? deduplicate<ValidationReasonCode>([...validation.warnings, 'SHORT_BASELINE'])
    : validation.warnings;
  const rawChange = input.current.value! - baselineMean.value;
  const standardized = standardizedChange(input.current.value!, baselineMean.value, baselineSd.value);
  const rawResult = makeResult({
    formulaId: 'MVP-09',
    observations,
    outputKey: 'raw_change',
    policyVersion: input.policyVersion,
    parameters,
    value: rawChange,
    unit: input.current.unit,
    state: stateFor([], warnings),
    warnings,
    computedAt: input.computedAt,
  });
  const standardizedResult = standardized.ok
    ? makeResult({
        formulaId: 'MVP-09',
        observations,
        outputKey: 'standardized_change',
        policyVersion: input.policyVersion,
        parameters,
        value: standardized.value,
        unit: 'ratio',
        state: stateFor([], warnings),
        warnings,
        computedAt: input.computedAt,
      })
    : makeResult({
        formulaId: 'MVP-09',
        observations,
        outputKey: 'standardized_change',
        policyVersion: input.policyVersion,
        parameters,
        value: null,
        unit: 'ratio',
        state: 'insufficient',
        hardBlocks: [standardized.reason],
        warnings,
        unavailableReason: standardized.reason,
        computedAt: input.computedAt,
      });
  return deepFreeze([rawResult, standardizedResult]);
}

export interface CompletenessPolicy {
  readonly expectedFieldKeys: readonly string[];
  readonly highAt: number;
  readonly moderateAt: number;
  readonly lowAt: number;
}

export function calculateDataCompleteness(input: {
  observations: readonly NumericObservation[];
  policy: CompletenessPolicy;
  policyVersion: string;
  computedAt?: string;
}): FormulaResult {
  const validation = commonValidation(input.observations, { requireSameContext: true });
  const expected = input.policy.expectedFieldKeys.map((key) => key.trim());
  if (
    !policyVersionIsValid(input.policyVersion)
    || expected.length === 0
    || expected.some((key) => !key)
    || new Set(expected).size !== expected.length
    || ![input.policy.lowAt, input.policy.moderateAt, input.policy.highAt].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
    || input.policy.lowAt > input.policy.moderateAt
    || input.policy.moderateAt > input.policy.highAt
  ) {
    validation.hardBlocks.push('INVALID_POLICY');
  }
  const fieldKeys = input.observations.map((observation) => dimensionString(observation, 'fieldKey'));
  if (fieldKeys.some((fieldKey) => !fieldKey || !expected.includes(fieldKey))) {
    validation.hardBlocks.push('INVALID_DIMENSION');
  }
  if (new Set(fieldKeys.filter(Boolean)).size !== fieldKeys.filter(Boolean).length) {
    validation.hardBlocks.push('DIMENSION_MISMATCH');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  const parameters = {
    expectedFieldKeys: expected,
    highAt: input.policy.highAt,
    moderateAt: input.policy.moderateAt,
    lowAt: input.policy.lowAt,
  };
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-10',
      observations: input.observations,
      policyVersion: input.policyVersion,
      parameters,
      value: null,
      state: 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  if (input.observations.length === 0) {
    return makeResult({
      formulaId: 'MVP-10',
      observations: input.observations,
      policyVersion: input.policyVersion,
      parameters,
      value: null,
      unit: 'ratio',
      state: 'insufficient',
      hardBlocks: ['INSUFFICIENT_DATA'],
      unavailableReason: 'INSUFFICIENT_DATA',
      completenessOverride: 0,
      computedAt: input.computedAt,
    });
  }
  const presentFields = new Set(
    input.observations
      .filter((observation) => observation.value != null && observation.source.quality !== 'failed')
      .map((observation) => dimensionString(observation, 'fieldKey'))
      .filter((fieldKey): fieldKey is string => Boolean(fieldKey)),
  );
  const completeness = expected.filter((fieldKey) => presentFields.has(fieldKey)).length / expected.length;
  const confidence: ConfidenceState = completeness >= input.policy.highAt
    ? 'HIGH'
    : completeness >= input.policy.moderateAt
      ? 'MODERATE'
      : completeness >= input.policy.lowAt
        ? 'LOW'
        : 'INSUFFICIENT';
  const warnings = completeness < 1
    ? deduplicate<ValidationReasonCode>([...validation.warnings, 'PARTIAL_FIELDS'])
    : validation.warnings;
  return makeResult({
    formulaId: 'MVP-10',
    observations: input.observations,
    policyVersion: input.policyVersion,
    parameters,
    value: completeness,
    unit: 'ratio',
    state: stateFor([], warnings),
    warnings,
    completenessOverride: completeness,
    confidenceOverride: confidence,
    computedAt: input.computedAt,
  });
}

export function calculateFocusAttainmentRate(input: {
  sessions: readonly NumericObservation<'focus_achieved', 'boolean_0_1'>[];
  computedAt?: string;
}): FormulaResult {
  const validation = commonValidation(input.sessions, { requireSameContext: false });
  if (input.sessions.length === 0) validation.hardBlocks.push('INSUFFICIENT_DATA');
  for (const session of input.sessions) {
    if (session.kind !== 'focus_achieved') validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
    if (session.unit !== 'boolean_0_1') validation.hardBlocks.push('UNIT_MISMATCH');
    if (session.value == null) validation.hardBlocks.push('MISSING_FOCUS');
    if (session.value != null && session.value !== 0 && session.value !== 1) {
      validation.hardBlocks.push('INVALID_BINARY_VALUE');
    }
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-11',
      observations: input.sessions,
      value: null,
      state: hardBlocks.includes('INSUFFICIENT_DATA') || hardBlocks.includes('MISSING_FOCUS')
        ? 'insufficient'
        : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  const achieved = input.sessions.reduce((sum, session) => sum + session.value!, 0);
  return makeResult({
    formulaId: 'MVP-11',
    observations: input.sessions,
    value: (achieved / input.sessions.length) * 100,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export interface WeightChangePolicy {
  readonly targetDays: 7;
  readonly toleranceHours: number;
}

export function calculateSevenDayWeightChange(input: {
  current: NumericObservation<'body_weight', 'kilograms' | 'pounds'>;
  prior: NumericObservation<'body_weight', 'kilograms' | 'pounds'>;
  policy: WeightChangePolicy;
  policyVersion: string;
  computedAt?: string;
}): FormulaResult {
  const observations = [input.prior, input.current] as const;
  const validation = commonValidation(observations, { requireSameContext: false });
  if (
    !policyVersionIsValid(input.policyVersion)
    || input.policy.targetDays !== 7
    || !Number.isFinite(input.policy.toleranceHours)
    || input.policy.toleranceHours < 0
    || input.policy.toleranceHours > 48
  ) {
    validation.hardBlocks.push('INVALID_POLICY');
  }
  if (input.current.kind !== 'body_weight' || input.prior.kind !== 'body_weight') {
    validation.hardBlocks.push('OBSERVATION_KIND_MISMATCH');
  }
  if (
    input.current.unit !== input.prior.unit
    || !['kilograms', 'pounds'].includes(input.current.unit)
  ) {
    validation.hardBlocks.push('UNIT_MISMATCH');
  }
  if (input.current.value == null || input.prior.value == null) {
    validation.hardBlocks.push('MISSING_WEIGHT');
  }
  if ((input.current.value ?? 1) <= 0 || (input.prior.value ?? 1) <= 0) {
    validation.hardBlocks.push('NEGATIVE_VALUE');
  }
  const currentMs = Date.parse(input.current.observedAt);
  const priorMs = Date.parse(input.prior.observedAt);
  const targetMs = input.policy.targetDays * 24 * 60 * 60 * 1_000;
  const toleranceMs = input.policy.toleranceHours * 60 * 60 * 1_000;
  if (
    Number.isFinite(currentMs)
    && Number.isFinite(priorMs)
    && (
      currentMs <= priorMs
      || Math.abs((currentMs - priorMs) - targetMs) > toleranceMs
    )
  ) {
    validation.hardBlocks.push('DATE_WINDOW_MISMATCH');
  }
  const hardBlocks = deduplicate(validation.hardBlocks);
  const parameters = {
    targetDays: input.policy.targetDays,
    toleranceHours: input.policy.toleranceHours,
  };
  if (hardBlocks.length > 0) {
    return makeResult({
      formulaId: 'MVP-12',
      observations,
      outputKey: 'weight_change',
      policyVersion: input.policyVersion,
      parameters,
      value: null,
      unit: input.current.unit,
      state: hardBlocks.includes('MISSING_WEIGHT') ? 'insufficient' : 'invalid',
      hardBlocks,
      warnings: validation.warnings,
      unavailableReason: firstHardBlock(hardBlocks),
      computedAt: input.computedAt,
    });
  }
  return makeResult({
    formulaId: 'MVP-12',
    observations,
    outputKey: 'weight_change',
    policyVersion: input.policyVersion,
    parameters,
    value: input.current.value! - input.prior.value!,
    unit: input.current.unit,
    state: stateFor([], validation.warnings),
    warnings: validation.warnings,
    computedAt: input.computedAt,
  });
}

export function unsupportedFormulaResult(input: {
  formulaId: FormulaId;
  observations?: readonly NumericObservation[];
  computedAt?: string;
}): FormulaResult {
  const definition = getFormulaDefinition(input.formulaId);
  if (definition.support === 'implemented' || definition.support === 'primitive_only') {
    throw new Error(`${input.formulaId} is not registered as unsupported.`);
  }
  return makeResult({
    formulaId: input.formulaId,
    observations: input.observations ?? [],
    value: null,
    state: 'unsupported',
    hardBlocks: ['UNSUPPORTED_FORMULA'],
    unavailableReason: 'UNSUPPORTED_FORMULA',
    computedAt: input.computedAt,
  });
}
