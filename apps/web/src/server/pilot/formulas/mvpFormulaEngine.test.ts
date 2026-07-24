import {
  SHADOW_FORMULA_REGISTRY,
  calculateAccuracyByPunchType,
  calculateConnectDifferential,
  calculateContactExposure,
  calculateDataCompleteness,
  calculateFocusAttainmentRate,
  calculateOffensiveEfficiency,
  calculatePersonalBaselineComparison,
  calculatePunchOutput,
  calculateRoundToRoundChange,
  calculateSevenDayWeightChange,
  calculateSessionLoad,
  calculateWorkRateConsistency,
  type FormulaUnit,
  type NumericObservation,
  type ObservationKind,
} from './index';

const COMPUTED_AT = '2026-07-28T13:00:00.000Z';

function observation<TKind extends ObservationKind, TUnit extends FormulaUnit>(input: {
  id: string;
  kind: TKind;
  unit: TUnit;
  value: number | null;
  observedAt?: string;
  contextId?: string;
  dimensions?: Readonly<Record<string, string | number | boolean | null>>;
}): NumericObservation<TKind, TUnit> {
  return Object.freeze({
    observationId: input.id,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: input.contextId ?? 'session-1',
    kind: input.kind,
    value: input.value,
    unit: input.unit,
    dimensions: Object.freeze({ ...(input.dimensions ?? {}) }),
    observedAt: input.observedAt ?? '2026-07-28T10:00:00.000Z',
    source: Object.freeze({
      type: 'system_timer' as const,
      quality: 'verified' as const,
      referenceId: `${input.id}-source`,
    }),
  });
}

describe('MVP formula registry coverage', () => {
  test('maps all 12 MVP formulas to executable, immutable definitions', () => {
    const mvp = SHADOW_FORMULA_REGISTRY.filter((item) => item.id.startsWith('MVP-'));
    expect(mvp.map((item) => item.id)).toEqual([
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
    for (const formula of mvp) {
      expect(formula.support).toBe('implemented');
      expect(formula.implementation).toBeTruthy();
      expect(formula.outputs.length).toBeGreaterThan(0);
      expect(Object.isFrozen(formula.outputs)).toBe(true);
      expect(formula.outputs.every(Object.isFrozen)).toBe(true);
    }
  });
});

describe('MVP formula golden values and fail-closed behavior', () => {
  test('MVP-02 calculates both punch-output measures and blocks missing denominators', () => {
    const valid = calculatePunchOutput({
      punches: observation({ id: 'punches', kind: 'punch_count', unit: 'count', value: 120 }),
      rounds: observation({ id: 'rounds', kind: 'round_count', unit: 'count', value: 3 }),
      activeTime: observation({ id: 'active', kind: 'active_time', unit: 'minutes', value: 6 }),
      computedAt: COMPUTED_AT,
    });
    expect(valid.map((result) => [result.outputKey, result.value])).toEqual([
      ['punches_per_round', 40],
      ['punches_per_active_minute', 20],
    ]);
    expect(new Set(valid.map((result) => result.calculationKey)).size).toBe(2);

    const unavailable = calculatePunchOutput({
      punches: observation({ id: 'punches-missing', kind: 'punch_count', unit: 'count', value: null }),
      rounds: observation({ id: 'rounds-present', kind: 'round_count', unit: 'count', value: 3 }),
      activeTime: observation({ id: 'active-zero', kind: 'active_time', unit: 'minutes', value: 0 }),
      computedAt: COMPUTED_AT,
    });
    expect(unavailable.every((result) => result.value === null)).toBe(true);
    expect(unavailable[0].validation.state).toBe('insufficient');
    expect(unavailable[0].validation.hardBlocks).toContain('MISSING_PUNCH_COUNT');
  });

  test('MVP-03 calculates accuracy by punch type and rejects impossible or mismatched pairs', () => {
    const landed = observation({
      id: 'jab-landed',
      kind: 'punch_landed',
      unit: 'count',
      value: 30,
      dimensions: { punchType: 'jab' },
    });
    const attempted = observation({
      id: 'jab-attempted',
      kind: 'punch_attempted',
      unit: 'count',
      value: 50,
      dimensions: { punchType: 'jab' },
    });
    const valid = calculateAccuracyByPunchType({ landed, attempted, computedAt: COMPUTED_AT });
    expect(valid.outputKey).toBe('accuracy_jab');
    expect(valid.value).toBe(60);
    expect(valid.parameters).toEqual({ punchType: 'jab' });

    const impossible = calculateAccuracyByPunchType({
      landed: { ...landed, value: 51 },
      attempted,
      computedAt: COMPUTED_AT,
    });
    expect(impossible.value).toBeNull();
    expect(impossible.validation.hardBlocks).toContain('LANDED_GT_ATTEMPTED');

    const mismatched = calculateAccuracyByPunchType({
      landed,
      attempted: { ...attempted, dimensions: { punchType: 'cross' } },
      computedAt: COMPUTED_AT,
    });
    expect(mismatched.value).toBeNull();
    expect(mismatched.validation.hardBlocks).toContain('DIMENSION_MISMATCH');
  });

  test('MVP-04 and MVP-05 match their golden values and do not divide by zero', () => {
    const landed = observation({
      id: 'landed',
      kind: 'punch_landed',
      unit: 'count',
      value: 36,
    });
    const differential = calculateConnectDifferential({
      landed,
      absorbed: observation({
        id: 'absorbed',
        kind: 'punch_absorbed',
        unit: 'count',
        value: 28,
      }),
      computedAt: COMPUTED_AT,
    });
    expect(differential.value).toBe(8);

    const missing = calculateConnectDifferential({
      landed,
      absorbed: observation({
        id: 'absorbed-missing',
        kind: 'punch_absorbed',
        unit: 'count',
        value: null,
      }),
      computedAt: COMPUTED_AT,
    });
    expect(missing.value).toBeNull();
    expect(missing.validation.state).toBe('insufficient');

    const efficiency = calculateOffensiveEfficiency({
      landed,
      activeTime: observation({
        id: 'active-six',
        kind: 'active_time',
        unit: 'minutes',
        value: 6,
      }),
      computedAt: COMPUTED_AT,
    });
    expect(efficiency.value).toBe(6);
    const noTime = calculateOffensiveEfficiency({
      landed,
      activeTime: observation({
        id: 'active-none',
        kind: 'active_time',
        unit: 'minutes',
        value: 0,
      }),
      computedAt: COMPUTED_AT,
    });
    expect(noTime.value).toBeNull();
    expect(noTime.validation.hardBlocks).toContain('ZERO_ACTIVE_TIME');
  });

  test('MVP-06 requires explicit complete coverage and calculates acute/chronic exposure', () => {
    const session = (
      suffix: string,
      observedAt: string,
      level: number,
      rounds: number,
    ) => ({
      level: observation({
        id: `level-${suffix}`,
        kind: 'contact_level' as const,
        unit: 'level_0_3' as const,
        value: level,
        observedAt,
        contextId: `contact-${suffix}`,
      }),
      rounds: observation({
        id: `rounds-${suffix}`,
        kind: 'contact_rounds' as const,
        unit: 'count' as const,
        value: rounds,
        observedAt,
        contextId: `contact-${suffix}`,
      }),
    });
    const sessions = [
      session('w0', '2026-07-27T12:00:00.000Z', 2, 3),
      session('w1', '2026-07-20T12:00:00.000Z', 1, 4),
      session('w2', '2026-07-13T12:00:00.000Z', 3, 2),
      session('w3', '2026-07-06T12:00:00.000Z', 1, 8),
    ];
    const policy = {
      asOf: '2026-07-28T12:00:00.000Z',
      acuteDays: 7 as const,
      chronicWeeks: 4 as const,
      coverageComplete: true,
    };
    const valid = calculateContactExposure({
      sessions,
      policy,
      policyVersion: 'contact-v1',
      computedAt: COMPUTED_AT,
    });
    expect(valid.map((result) => [result.outputKey, result.value])).toEqual([
      ['acute_7_day', 6],
      ['chronic_4_week', 6],
    ]);
    expect(valid[0].policyVersion).toBe('contact-v1');
    expect(valid[0].parameters).toEqual(policy);

    const incomplete = calculateContactExposure({
      sessions,
      policy: { ...policy, coverageComplete: false },
      policyVersion: 'contact-v1',
      computedAt: COMPUTED_AT,
    });
    expect(incomplete.every((result) => result.value === null)).toBe(true);
    expect(incomplete[0].validation.hardBlocks).toContain('INCOMPLETE_WINDOW');
  });

  test('MVP-07 calculates round-output CV and requires at least two ordered rounds', () => {
    const rounds = [10, 12, 8].map((value, index) => observation({
      id: `round-${index + 1}`,
      kind: 'round_output' as const,
      unit: 'count' as const,
      value,
      dimensions: { round: index + 1 },
    }));
    const valid = calculateWorkRateConsistency({ rounds, computedAt: COMPUTED_AT });
    expect(valid.value).toBeCloseTo(20, 10);

    const insufficient = calculateWorkRateConsistency({
      rounds: rounds.slice(0, 1),
      computedAt: COMPUTED_AT,
    });
    expect(insufficient.value).toBeNull();
    expect(insufficient.validation.hardBlocks).toContain('INSUFFICIENT_ROUNDS');
  });

  test('MVP-08 returns raw and percent round changes independently', () => {
    const previous = observation({
      id: 'round-prev',
      kind: 'round_output',
      unit: 'count',
      value: 10,
      dimensions: { round: 1 },
    });
    const current = observation({
      id: 'round-current',
      kind: 'round_output',
      unit: 'count',
      value: 8,
      dimensions: { round: 2 },
    });
    const valid = calculateRoundToRoundChange({ previous, current, computedAt: COMPUTED_AT });
    expect(valid.map((result) => [result.outputKey, result.value])).toEqual([
      ['raw_change', -2],
      ['percent_change', -20],
    ]);

    const zeroBaseline = calculateRoundToRoundChange({
      previous: { ...previous, value: 0 },
      current,
      computedAt: COMPUTED_AT,
    });
    expect(zeroBaseline[0].value).toBe(8);
    expect(zeroBaseline[1].value).toBeNull();
    expect(zeroBaseline[1].validation.hardBlocks).toContain('DIV_BY_ZERO');
  });

  test('MVP-09 snapshots explicit personal-baseline policy and short-history confidence', () => {
    const numeric = (id: string, value: number, day: number) => observation({
      id,
      kind: 'numeric' as const,
      unit: 'count' as const,
      value,
      observedAt: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      contextId: `metric-${day}`,
      dimensions: { metricKey: 'jab_count' },
    });
    const history = [
      numeric('base-1', 8, 1),
      numeric('base-2', 9, 2),
      numeric('base-3', 10, 3),
      numeric('base-4', 11, 4),
    ];
    const policy = {
      metricKey: 'jab_count',
      windowSize: 8,
      minimumHistory: 4 as const,
      adequateHistory: 8,
    };
    const valid = calculatePersonalBaselineComparison({
      current: numeric('current', 12, 5),
      history,
      policy,
      policyVersion: 'baseline-v1',
      computedAt: COMPUTED_AT,
    });
    expect(valid[0].value).toBe(2.5);
    expect(valid[1].value).toBeCloseTo(1.936491673, 8);
    expect(valid[0].validation.state).toBe('warning');
    expect(valid[0].validation.warnings).toContain('SHORT_BASELINE');
    expect(valid[0].parameters).toEqual(policy);

    const insufficient = calculatePersonalBaselineComparison({
      current: numeric('current-short', 12, 5),
      history: history.slice(0, 3),
      policy,
      policyVersion: 'baseline-v1',
      computedAt: COMPUTED_AT,
    });
    expect(insufficient.every((result) => result.value === null)).toBe(true);
    expect(insufficient[0].validation.hardBlocks).toContain('INSUFFICIENT_HISTORY');
  });

  test('MVP-10 calculates completeness with explicit thresholds and fails closed with no data', () => {
    const fields = ['rpe', 'duration', 'rounds'].map((fieldKey, index) => observation({
      id: `field-${fieldKey}`,
      kind: 'numeric' as const,
      unit: 'unitless' as const,
      value: index + 1,
      dimensions: { fieldKey },
    }));
    const policy = {
      expectedFieldKeys: ['rpe', 'duration', 'rounds', 'punches'],
      highAt: 1,
      moderateAt: 0.75,
      lowAt: 0.5,
    };
    const valid = calculateDataCompleteness({
      observations: fields,
      policy,
      policyVersion: 'completeness-v1',
      computedAt: COMPUTED_AT,
    });
    expect(valid.value).toBe(0.75);
    expect(valid.quality.completeness).toBe(0.75);
    expect(valid.quality.confidence).toBe('MODERATE');
    expect(valid.validation.warnings).toContain('PARTIAL_FIELDS');

    const empty = calculateDataCompleteness({
      observations: [],
      policy,
      policyVersion: 'completeness-v1',
      computedAt: COMPUTED_AT,
    });
    expect(empty.value).toBeNull();
    expect(empty.validation.state).toBe('insufficient');
    expect(empty.validation.hardBlocks).toContain('INSUFFICIENT_DATA');
  });

  test('MVP-11 calculates eligible-session attainment and rejects non-binary values', () => {
    const sessions = [1, 0, 1, 1].map((value, index) => observation({
      id: `focus-${index}`,
      kind: 'focus_achieved' as const,
      unit: 'boolean_0_1' as const,
      value,
      contextId: `focus-session-${index}`,
      observedAt: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    }));
    expect(calculateFocusAttainmentRate({ sessions, computedAt: COMPUTED_AT }).value).toBe(75);
    const invalid = calculateFocusAttainmentRate({
      sessions: [{ ...sessions[0], value: 2 }],
      computedAt: COMPUTED_AT,
    });
    expect(invalid.value).toBeNull();
    expect(invalid.validation.hardBlocks).toContain('INVALID_BINARY_VALUE');
  });

  test('MVP-12 calculates measured seven-day weight change and rejects another interval', () => {
    const prior = observation({
      id: 'weight-prior',
      kind: 'body_weight',
      unit: 'kilograms',
      value: 70,
      observedAt: '2026-07-21T10:00:00.000Z',
      contextId: 'weigh-in-1',
    });
    const current = observation({
      id: 'weight-current',
      kind: 'body_weight',
      unit: 'kilograms',
      value: 69.2,
      observedAt: '2026-07-28T10:00:00.000Z',
      contextId: 'weigh-in-2',
    });
    const policy = { targetDays: 7 as const, toleranceHours: 0 };
    const valid = calculateSevenDayWeightChange({
      prior,
      current,
      policy,
      policyVersion: 'weight-v1',
      computedAt: COMPUTED_AT,
    });
    expect(valid.value).toBeCloseTo(-0.8, 10);
    expect(valid.unit).toBe('kilograms');
    expect(valid.humanReviewRequired).toBe(true);

    const wrongInterval = calculateSevenDayWeightChange({
      prior: { ...prior, observedAt: '2026-07-22T10:00:00.000Z' },
      current,
      policy,
      policyVersion: 'weight-v1',
      computedAt: COMPUTED_AT,
    });
    expect(wrongInterval.value).toBeNull();
    expect(wrongInterval.validation.hardBlocks).toContain('DATE_WINDOW_MISMATCH');
  });

  test('calculation identity is independent of execution time but changes with policy inputs', () => {
    const rpe = observation({
      id: 'identity-rpe',
      kind: 'session_rpe',
      unit: 'rpe_0_10',
      value: 5,
    });
    const duration = observation({
      id: 'identity-duration',
      kind: 'duration',
      unit: 'minutes',
      value: 30,
    });
    const first = calculateSessionLoad({ rpe, duration, computedAt: COMPUTED_AT });
    const second = calculateSessionLoad({
      rpe,
      duration,
      computedAt: '2026-07-29T13:00:00.000Z',
    });
    expect(first.calculationKey).toBe(second.calculationKey);

    const field = observation({
      id: 'identity-field',
      kind: 'numeric',
      unit: 'unitless',
      value: 1,
      dimensions: { fieldKey: 'rpe' },
    });
    const strict = calculateDataCompleteness({
      observations: [field],
      policy: {
        expectedFieldKeys: ['rpe'],
        highAt: 1,
        moderateAt: 0.75,
        lowAt: 0.5,
      },
      policyVersion: 'confidence-v1',
      computedAt: COMPUTED_AT,
    });
    const relaxed = calculateDataCompleteness({
      observations: [field],
      policy: {
        expectedFieldKeys: ['rpe'],
        highAt: 0.9,
        moderateAt: 0.7,
        lowAt: 0.4,
      },
      policyVersion: 'confidence-v1',
      computedAt: COMPUTED_AT,
    });
    expect(strict.calculationKey).not.toBe(relaxed.calculationKey);
  });
});
