import {
  calculateAccuracyByPunchType,
  calculateConnectDifferential,
  calculateContactExposure,
  calculateDataCompleteness,
  calculateFocusAttainmentRate,
  calculateOffensiveEfficiency,
  calculatePersonalBaselineComparison,
  calculatePunchOutput,
  calculateRoundToRoundChange,
  calculateSessionLoad,
  calculateSevenDayWeightChange,
  calculateWorkRateConsistency,
  type CompletenessPolicy,
  type ContactExposurePolicy,
  type PersonalBaselinePolicy,
  type WeightChangePolicy,
} from './engine';
import {
  buildPersonalBaselineSnapshot,
  savePersonalBaselineSnapshotWithClient,
  type BaselinePolicy,
} from './baseline';
import { withTransaction } from '../db';
import { stableJson } from './identity';
import {
  findFormulaResultsUsingObservation,
  getActiveFormulaObservationsByIds,
  saveFormulaResultsWithClient,
} from './repository';
import type {
  FormulaBaselineSnapshot,
  FormulaResult,
  MvpFormulaId,
  NumericObservation,
  ObservationKind,
} from './types';

const MVP_FORMULA_IDS = new Set<MvpFormulaId>([
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
]);

const POLICY_FORMULA_IDS = new Set<MvpFormulaId>([
  'MVP-06',
  'MVP-09',
  'MVP-10',
  'MVP-12',
]);

export class FormulaExecutionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT_SET' | 'INVALID_PARAMETERS' | 'UNSUPPORTED_FORMULA',
    message: string,
  ) {
    super(message);
    this.name = 'FormulaExecutionError';
  }
}

export interface RunStoredMvpFormulaInput {
  organizationId: string;
  athleteId: string;
  formulaId: MvpFormulaId;
  observationIds: readonly string[];
  parameters?: Readonly<Record<string, unknown>>;
  policyVersion?: string;
  computedAt?: string;
}

export interface RunStoredMvpFormulaOutput {
  readonly results: readonly FormulaResult[];
  readonly baselineSnapshot?: FormulaBaselineSnapshot;
}

function executionError(
  message: string,
  code: FormulaExecutionError['code'] = 'INVALID_INPUT_SET',
): never {
  throw new FormulaExecutionError(code, message);
}

export function isMvpFormulaId(value: unknown): value is MvpFormulaId {
  return typeof value === 'string' && MVP_FORMULA_IDS.has(value as MvpFormulaId);
}

function observationsOfKind<TKind extends ObservationKind>(
  observations: readonly NumericObservation[],
  kind: TKind,
): NumericObservation<TKind>[] {
  return observations.filter(
    (observation): observation is NumericObservation<TKind> => observation.kind === kind,
  );
}

function exactObservationSet(
  observations: readonly NumericObservation[],
  expected: Readonly<Partial<Record<ObservationKind, number>>>,
): void {
  const expectedKinds = new Set(Object.keys(expected) as ObservationKind[]);
  if (observations.some((observation) => !expectedKinds.has(observation.kind))) {
    executionError('Formula input contains an observation kind that is not accepted.');
  }
  for (const [kind, count] of Object.entries(expected) as [ObservationKind, number][]) {
    if (observationsOfKind(observations, kind).length !== count) {
      executionError(`Formula input requires exactly ${count} ${kind} observation(s).`);
    }
  }
}

function sortChronologically<T extends NumericObservation>(observations: readonly T[]): T[] {
  return [...observations].sort((left, right) => {
    const timestampDifference = Date.parse(left.observedAt) - Date.parse(right.observedAt);
    return timestampDifference || left.observationId.localeCompare(right.observationId);
  });
}

function dimensionString(observation: NumericObservation, key: string): string {
  const value = observation.dimensions?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function dimensionNumber(observation: NumericObservation, key: string): number {
  const value = observation.dimensions?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function requirePolicyVersion(input: RunStoredMvpFormulaInput): string {
  const policyVersion = input.policyVersion?.trim();
  if (!policyVersion || policyVersion.length > 120) {
    executionError(
      'Formula policyVersion is required and must be no longer than 120 characters.',
      'INVALID_PARAMETERS',
    );
  }
  return policyVersion;
}

function parameterObject(input: RunStoredMvpFormulaInput): Readonly<Record<string, unknown>> {
  if (!input.parameters || Array.isArray(input.parameters)) {
    executionError('Formula parameters must be an explicit object.', 'INVALID_PARAMETERS');
  }
  return input.parameters;
}

function assertExactParameterKeys(
  parameters: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  const actual = Object.keys(parameters).sort();
  const expected = [...keys].sort();
  if (stableJson(actual) !== stableJson(expected)) {
    executionError(
      `Formula parameters must contain exactly: ${expected.join(', ')}.`,
      'INVALID_PARAMETERS',
    );
  }
}

function parseContactPolicy(input: RunStoredMvpFormulaInput): {
  policy: ContactExposurePolicy;
  policyVersion: string;
} {
  const parameters = parameterObject(input);
  assertExactParameterKeys(parameters, ['asOf', 'acuteDays', 'chronicWeeks', 'coverageComplete']);
  if (
    typeof parameters.asOf !== 'string'
    || !Number.isFinite(Date.parse(parameters.asOf))
    || parameters.acuteDays !== 7
    || parameters.chronicWeeks !== 4
    || typeof parameters.coverageComplete !== 'boolean'
  ) {
    executionError('Contact-exposure parameters are invalid.', 'INVALID_PARAMETERS');
  }
  return {
    policy: {
      asOf: parameters.asOf,
      acuteDays: 7,
      chronicWeeks: 4,
      coverageComplete: parameters.coverageComplete,
    },
    policyVersion: requirePolicyVersion(input),
  };
}

function parseBaselinePolicy(input: RunStoredMvpFormulaInput): {
  policy: PersonalBaselinePolicy & BaselinePolicy;
  policyVersion: string;
} {
  const parameters = parameterObject(input);
  assertExactParameterKeys(parameters, [
    'metricKey',
    'windowSize',
    'minimumHistory',
    'adequateHistory',
  ]);
  if (
    typeof parameters.metricKey !== 'string'
    || !parameters.metricKey.trim()
    || parameters.metricKey.length > 120
    || !Number.isInteger(parameters.windowSize)
    || (parameters.windowSize as number) < 8
    || (parameters.windowSize as number) > 12
    || parameters.minimumHistory !== 4
    || !Number.isInteger(parameters.adequateHistory)
    || (parameters.adequateHistory as number) < 8
    || (parameters.adequateHistory as number) > (parameters.windowSize as number)
  ) {
    executionError('Personal-baseline parameters are invalid.', 'INVALID_PARAMETERS');
  }
  const policyVersion = requirePolicyVersion(input);
  return {
    policy: {
      metricKey: parameters.metricKey.trim(),
      windowSize: parameters.windowSize as number,
      minimumHistory: 4,
      adequateHistory: parameters.adequateHistory as number,
      policyVersion,
    },
    policyVersion,
  };
}

function parseCompletenessPolicy(input: RunStoredMvpFormulaInput): {
  policy: CompletenessPolicy;
  policyVersion: string;
} {
  const parameters = parameterObject(input);
  assertExactParameterKeys(parameters, ['expectedFieldKeys', 'highAt', 'moderateAt', 'lowAt']);
  const expectedFieldKeys = Array.isArray(parameters.expectedFieldKeys)
    ? parameters.expectedFieldKeys
    : [];
  if (
    expectedFieldKeys.length === 0
    || expectedFieldKeys.length > 100
    || expectedFieldKeys.some(
      (value) => typeof value !== 'string' || !value.trim() || value.length > 120,
    )
    || new Set(expectedFieldKeys.map((value) => (value as string).trim())).size
      !== expectedFieldKeys.length
    || ![parameters.highAt, parameters.moderateAt, parameters.lowAt].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    )
    || (parameters.lowAt as number) > (parameters.moderateAt as number)
    || (parameters.moderateAt as number) > (parameters.highAt as number)
  ) {
    executionError('Data-completeness parameters are invalid.', 'INVALID_PARAMETERS');
  }
  return {
    policy: {
      expectedFieldKeys: expectedFieldKeys.map((value) => (value as string).trim()),
      highAt: parameters.highAt as number,
      moderateAt: parameters.moderateAt as number,
      lowAt: parameters.lowAt as number,
    },
    policyVersion: requirePolicyVersion(input),
  };
}

function parseWeightPolicy(input: RunStoredMvpFormulaInput): {
  policy: WeightChangePolicy;
  policyVersion: string;
} {
  const parameters = parameterObject(input);
  assertExactParameterKeys(parameters, ['targetDays', 'toleranceHours']);
  if (
    parameters.targetDays !== 7
    || typeof parameters.toleranceHours !== 'number'
    || !Number.isFinite(parameters.toleranceHours)
    || parameters.toleranceHours < 0
    || parameters.toleranceHours > 48
  ) {
    executionError('Weight-change parameters are invalid.', 'INVALID_PARAMETERS');
  }
  return {
    policy: {
      targetDays: 7,
      toleranceHours: parameters.toleranceHours,
    },
    policyVersion: requirePolicyVersion(input),
  };
}

function groupPairs(
  observations: readonly NumericObservation[],
  leftKind: ObservationKind,
  rightKind: ObservationKind,
  groupKey: (observation: NumericObservation) => string,
): readonly [NumericObservation, NumericObservation][] {
  if (observations.some((observation) => (
    observation.kind !== leftKind && observation.kind !== rightKind
  ))) {
    executionError('Formula input contains an observation kind that is not accepted.');
  }
  const groups = new Map<string, NumericObservation[]>();
  for (const observation of observations) {
    const key = groupKey(observation);
    const members = groups.get(key) ?? [];
    members.push(observation);
    groups.set(key, members);
  }
  const pairs: [NumericObservation, NumericObservation][] = [];
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!;
    const left = members.filter((observation) => observation.kind === leftKind);
    const right = members.filter((observation) => observation.kind === rightKind);
    if (left.length !== 1 || right.length !== 1) {
      executionError(
        `Formula input requires one ${leftKind} and one ${rightKind} observation per group.`,
      );
    }
    pairs.push([left[0], right[0]]);
  }
  if (pairs.length === 0) {
    executionError('Formula input requires at least one complete observation pair.');
  }
  return pairs;
}

function calculateStoredFormula(
  input: RunStoredMvpFormulaInput,
  observations: readonly NumericObservation[],
): RunStoredMvpFormulaOutput {
  switch (input.formulaId) {
    case 'MVP-01': {
      exactObservationSet(observations, { session_rpe: 1, duration: 1 });
      return {
        results: [calculateSessionLoad({
          formulaId: 'MVP-01',
          rpe: observationsOfKind(observations, 'session_rpe')[0] as NumericObservation<'session_rpe', 'rpe_0_10'>,
          duration: observationsOfKind(observations, 'duration')[0] as NumericObservation<'duration', 'minutes'>,
          computedAt: input.computedAt,
        })],
      };
    }
    case 'MVP-02': {
      exactObservationSet(
        observations,
        { punch_count: 1, round_count: 1, active_time: 1 },
      );
      return {
        results: calculatePunchOutput({
          punches: observationsOfKind(observations, 'punch_count')[0] as NumericObservation<'punch_count', 'count'>,
          rounds: observationsOfKind(observations, 'round_count')[0] as NumericObservation<'round_count', 'count'>,
          activeTime: observationsOfKind(observations, 'active_time')[0] as NumericObservation<'active_time', 'minutes'>,
          computedAt: input.computedAt,
        }),
      };
    }
    case 'MVP-03': {
      const pairs = groupPairs(
        observations,
        'punch_landed',
        'punch_attempted',
        (observation) => `${observation.contextId}\u0000${dimensionString(observation, 'punchType')}`,
      );
      return {
        results: pairs.map(([landed, attempted]) => calculateAccuracyByPunchType({
          landed: landed as NumericObservation<'punch_landed', 'count'>,
          attempted: attempted as NumericObservation<'punch_attempted', 'count'>,
          computedAt: input.computedAt,
        })),
      };
    }
    case 'MVP-04': {
      exactObservationSet(
        observations,
        { punch_landed: 1, punch_absorbed: 1 },
      );
      return {
        results: [calculateConnectDifferential({
          landed: observationsOfKind(observations, 'punch_landed')[0] as NumericObservation<'punch_landed', 'count'>,
          absorbed: observationsOfKind(observations, 'punch_absorbed')[0] as NumericObservation<'punch_absorbed', 'count'>,
          computedAt: input.computedAt,
        })],
      };
    }
    case 'MVP-05': {
      exactObservationSet(
        observations,
        { punch_landed: 1, active_time: 1 },
      );
      return {
        results: [calculateOffensiveEfficiency({
          landed: observationsOfKind(observations, 'punch_landed')[0] as NumericObservation<'punch_landed', 'count'>,
          activeTime: observationsOfKind(observations, 'active_time')[0] as NumericObservation<'active_time', 'minutes'>,
          computedAt: input.computedAt,
        })],
      };
    }
    case 'MVP-06': {
      const { policy, policyVersion } = parseContactPolicy(input);
      const pairs = groupPairs(
        observations,
        'contact_level',
        'contact_rounds',
        (observation) => observation.contextId,
      );
      return {
        results: calculateContactExposure({
          sessions: pairs.map(([level, rounds]) => ({
            level: level as NumericObservation<'contact_level', 'level_0_3'>,
            rounds: rounds as NumericObservation<'contact_rounds', 'count'>,
          })),
          policy,
          policyVersion,
          computedAt: input.computedAt,
        }),
      };
    }
    case 'MVP-07': {
      if (observations.some((observation) => observation.kind !== 'round_output')) {
        executionError('Work-rate consistency accepts only round_output observations.');
      }
      const rounds = [...observationsOfKind(observations, 'round_output')].sort(
        (left, right) => dimensionNumber(left, 'round') - dimensionNumber(right, 'round')
          || left.observationId.localeCompare(right.observationId),
      );
      return {
        results: [calculateWorkRateConsistency({
          rounds,
          computedAt: input.computedAt,
        })],
      };
    }
    case 'MVP-08': {
      exactObservationSet(
        observations,
        { round_output: 2 },
      );
      const rounds = [...observationsOfKind(observations, 'round_output')].sort(
        (left, right) => dimensionNumber(left, 'round') - dimensionNumber(right, 'round')
          || left.observationId.localeCompare(right.observationId),
      );
      return {
        results: calculateRoundToRoundChange({
          previous: rounds[0],
          current: rounds[1],
          computedAt: input.computedAt,
        }),
      };
    }
    case 'MVP-09': {
      if (observations.some((observation) => observation.kind !== 'numeric')) {
        executionError('Personal baseline accepts only numeric observations.');
      }
      const { policy, policyVersion } = parseBaselinePolicy(input);
      const ordered = sortChronologically(observationsOfKind(observations, 'numeric'));
      if (ordered.length === 0) {
        executionError('Personal baseline requires a current numeric observation.');
      }
      const current = ordered[ordered.length - 1];
      const history = ordered.slice(0, -1);
      const snapshot = buildPersonalBaselineSnapshot({
        organizationId: input.organizationId,
        athleteId: input.athleteId,
        unit: current.unit,
        history,
        policy,
        effectiveAt: current.observedAt,
      });
      return {
        baselineSnapshot: snapshot,
        results: calculatePersonalBaselineComparison({
          current,
          history,
          policy,
          policyVersion,
          computedAt: input.computedAt,
        }),
      };
    }
    case 'MVP-10': {
      const { policy, policyVersion } = parseCompletenessPolicy(input);
      return {
        results: [calculateDataCompleteness({
          observations,
          policy,
          policyVersion,
          computedAt: input.computedAt,
        })],
      };
    }
    case 'MVP-11': {
      if (observations.some((observation) => observation.kind !== 'focus_achieved')) {
        executionError('Focus attainment accepts only focus_achieved observations.');
      }
      return {
        results: [calculateFocusAttainmentRate({
          sessions: sortChronologically(
            observationsOfKind(observations, 'focus_achieved'),
          ) as NumericObservation<'focus_achieved', 'boolean_0_1'>[],
          computedAt: input.computedAt,
        })],
      };
    }
    case 'MVP-12': {
      exactObservationSet(
        observations,
        { body_weight: 2 },
      );
      const { policy, policyVersion } = parseWeightPolicy(input);
      const weights = sortChronologically(
        observationsOfKind(observations, 'body_weight'),
      ) as NumericObservation<'body_weight', 'kilograms' | 'pounds'>[];
      return {
        results: [calculateSevenDayWeightChange({
          prior: weights[0],
          current: weights[1],
          policy,
          policyVersion,
          computedAt: input.computedAt,
        })],
      };
    }
    default:
      return executionError('Formula is not an executable MVP formula.', 'UNSUPPORTED_FORMULA');
  }
}

export async function runStoredMvpFormula(
  input: RunStoredMvpFormulaInput,
): Promise<RunStoredMvpFormulaOutput> {
  if (
    !input.organizationId.trim()
    || !input.athleteId.trim()
    || !isMvpFormulaId(input.formulaId)
    || input.observationIds.length === 0
    || input.observationIds.length > 500
    || input.observationIds.some((observationId) => !observationId.trim())
    || new Set(input.observationIds).size !== input.observationIds.length
    || (input.computedAt != null && !Number.isFinite(Date.parse(input.computedAt)))
  ) {
    executionError('Formula execution input is invalid.');
  }
  if (
    !POLICY_FORMULA_IDS.has(input.formulaId)
    && (input.parameters != null || input.policyVersion != null)
  ) {
    executionError(
      'This formula does not accept policy parameters.',
      'INVALID_PARAMETERS',
    );
  }

  const observations = await getActiveFormulaObservationsByIds({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    observationIds: input.observationIds,
  });
  const calculated = calculateStoredFormula(input, observations);
  const persisted = await withTransaction(async (client) => {
    const baselineSnapshot = calculated.baselineSnapshot
      ? await savePersonalBaselineSnapshotWithClient(client, calculated.baselineSnapshot)
      : undefined;
    const results = await saveFormulaResultsWithClient(client, calculated.results);
    return { baselineSnapshot, results };
  });
  return Object.freeze({
    results: Object.freeze(persisted.results),
    ...(persisted.baselineSnapshot
      ? { baselineSnapshot: persisted.baselineSnapshot }
      : {}),
  });
}

export async function recalculateForSupersededObservation(input: {
  organizationId: string;
  athleteId: string;
  supersededObservationId: string;
  replacementObservationId: string;
  computedAt?: string;
}): Promise<readonly FormulaResult[]> {
  if (
    !input.organizationId.trim()
    || !input.athleteId.trim()
    || !input.supersededObservationId.trim()
    || !input.replacementObservationId.trim()
    || input.supersededObservationId === input.replacementObservationId
  ) {
    executionError('Superseded-observation recalculation input is invalid.');
  }
  const priorResults = await findFormulaResultsUsingObservation({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    observationId: input.supersededObservationId,
  });
  const calculations = new Map<string, FormulaResult>();
  for (const result of priorResults) {
    if (!isMvpFormulaId(result.formulaId)) continue;
    const key = stableJson({
      formulaId: result.formulaId,
      formulaVersion: result.formulaVersion,
      policyVersion: result.policyVersion,
      parameters: result.parameters,
      inputObservationIds: result.inputObservationIds,
    });
    if (!calculations.has(key)) calculations.set(key, result);
  }

  const recalculated: FormulaResult[] = [];
  for (const prior of calculations.values()) {
    const replacementIds = prior.inputObservationIds.map((observationId) => (
      observationId === input.supersededObservationId
        ? input.replacementObservationId
        : observationId
    ));
    const output = await runStoredMvpFormula({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      formulaId: prior.formulaId as MvpFormulaId,
      observationIds: replacementIds,
      ...(POLICY_FORMULA_IDS.has(prior.formulaId as MvpFormulaId)
        ? {
            parameters: prior.parameters,
            policyVersion: prior.policyVersion,
          }
        : {}),
      computedAt: input.computedAt,
    });
    recalculated.push(...output.results);
  }
  return Object.freeze(recalculated);
}
