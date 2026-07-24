import {
  acuteChronicWorkloadRatio,
  ewma,
  rollingMean,
} from './primitives';
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
  value: number | null;
  unit?: FormulaUnit;
  state: ValidationState;
  hardBlocks?: readonly ValidationReasonCode[];
  warnings?: readonly ValidationReasonCode[];
  unavailableReason?: ValidationReasonCode | null;
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
  });
}

function makeResult(input: ResultInput): FormulaResult {
  const definition = getFormulaDefinition(input.formulaId);
  const hardBlocks = deduplicate(input.hardBlocks ?? []);
  const warnings = deduplicate(input.warnings ?? []);
  const valuesPresent = input.observations.filter((observation) => observation.value != null).length;
  const completeness = input.observations.length === 0
    ? 0
    : valuesPresent / input.observations.length;
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
  const resultId = [
    input.formulaId,
    definition.version,
    ...input.observations.map((item) => item.observationId),
    computedAt,
  ].join(':');

  return deepFreeze({
    resultId,
    formulaId: input.formulaId,
    formulaVersion: definition.version,
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
      confidence: confidenceFor(effectiveState, worstQuality, warnings),
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
