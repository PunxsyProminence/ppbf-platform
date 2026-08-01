import {
  calculateAcuteChronicWorkloadRatio,
  calculateAttendanceRate,
  calculateEwmaLoad,
  calculateRollingLoad,
  calculateSessionLoad,
  unsupportedFormulaResult,
} from './engine';
import {
  acuteChronicWorkloadRatio,
  ewma,
  mean,
  rollingMean,
  sampleStandardDeviation,
  smallestWorthwhileChangeBetweenAthletes,
  smallestWorthwhileChangeWithinAthlete,
  standardizedChange,
} from './primitives';
import { SHADOW_FORMULA_REGISTRY, getFormulaDefinition } from './registry';
import {
  FORMULA_IDS,
  type FormulaUnit,
  type NumericObservation,
  type ObservationKind,
  type ObservationSourceType,
  type SourceQuality,
} from './types';

const COMPUTED_AT = '2026-07-23T12:00:00.000Z';

function observation<TKind extends ObservationKind, TUnit extends FormulaUnit>(input: {
  id: string;
  kind: TKind;
  unit: TUnit;
  value: number | null;
  observedAt?: string;
  organizationId?: string;
  athleteId?: string | null;
  contextId?: string;
  sourceType?: ObservationSourceType;
  sourceQuality?: SourceQuality;
}): NumericObservation<TKind, TUnit> {
  return Object.freeze({
    observationId: input.id,
    organizationId: input.organizationId ?? 'org-1',
    athleteId: input.athleteId === undefined ? 'athlete-1' : input.athleteId,
    contextId: input.contextId ?? 'session-1',
    kind: input.kind,
    value: input.value,
    unit: input.unit,
    observedAt: input.observedAt ?? '2026-07-23T10:00:00.000Z',
    source: Object.freeze({
      type: input.sourceType ?? 'system_timer',
      quality: input.sourceQuality ?? 'verified',
      referenceId: `${input.id}-source`,
    }),
  });
}

function load(
  id: string,
  value: number | null,
  day: number,
  overrides: Partial<{
    organizationId: string;
    athleteId: string | null;
    sourceType: ObservationSourceType;
    sourceQuality: SourceQuality;
  }> = {},
): NumericObservation<'session_load', 'au'> {
  return observation({
    id,
    kind: 'session_load',
    unit: 'au',
    value,
    observedAt: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    contextId: `session-${day}`,
    ...overrides,
  });
}

describe('SHADOW formula registry', () => {
  test('accounts for every supplied formula group exactly once', () => {
    expect(FORMULA_IDS).toHaveLength(39);
    expect(SHADOW_FORMULA_REGISTRY).toHaveLength(39);
    expect(new Set(SHADOW_FORMULA_REGISTRY.map((item) => item.id)).size).toBe(39);
    expect(SHADOW_FORMULA_REGISTRY.map((item) => item.id)).toEqual(FORMULA_IDS);
  });

  test('versions every entry and gives every unsupported formula a reason', () => {
    for (const item of SHADOW_FORMULA_REGISTRY) {
      expect(item.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.requiredObservationKinds)).toBe(true);
      if (item.support === 'unsupported' || item.support === 'experimental_unsupported') {
        expect(item.unsupportedReason?.length).toBeGreaterThan(20);
      }
    }
  });

  test('keeps the legacy readiness equation explicitly unsupported', () => {
    const readiness = getFormulaDefinition('LEGACY-READINESS');
    expect(readiness.support).toBe('experimental_unsupported');
    expect(readiness.humanReviewRequired).toBe(true);
    expect(readiness.unsupportedReason).toContain('unproven');
  });
});

describe('numeric primitives', () => {
  test('matches golden mean and sample-SD values', () => {
    expect(mean([2, 4, 6, 8])).toEqual({ ok: true, value: 5 });
    expect(sampleStandardDeviation([1, 2, 3])).toEqual({ ok: true, value: 1 });
  });

  test('uses only the last complete rolling window', () => {
    expect(rollingMean([10, 20, 30, 50], 3)).toEqual({
      ok: true,
      value: 100 / 3,
    });
    expect(rollingMean([10, 20], 3)).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_HISTORY',
    });
  });

  test('matches the golden EWMA recurrence', () => {
    expect(ewma([10, 20, 30], 0.5)).toEqual({
      ok: true,
      value: 22.5,
      series: [10, 15, 22.5],
    });
  });

  test('calculates standardized change, SWC, and ACWR without policy invention', () => {
    expect(standardizedChange(12, 10, 2)).toEqual({ ok: true, value: 1 });
    expect(smallestWorthwhileChangeBetweenAthletes(5)).toEqual({ ok: true, value: 1 });
    expect(smallestWorthwhileChangeWithinAthlete(0.1)).toEqual({ ok: true, value: 0.03 });
    expect(acuteChronicWorkloadRatio(500, 400)).toEqual({ ok: true, value: 1.25 });
  });

  test.each([
    [mean([]), 'INSUFFICIENT_DATA'],
    [mean([1, Number.NaN]), 'NON_FINITE_VALUE'],
    [sampleStandardDeviation([1]), 'INSUFFICIENT_HISTORY'],
    [rollingMean([1], 0), 'INVALID_WINDOW'],
    [ewma([1, 2], 0), 'INVALID_LAMBDA'],
    [ewma([1, Number.POSITIVE_INFINITY], 0.2), 'NON_FINITE_VALUE'],
    [standardizedChange(2, 1, 0), 'ZERO_VARIANCE'],
    [acuteChronicWorkloadRatio(10, 0), 'ZERO_CHRONIC_LOAD'],
  ])('returns an explicit failure instead of NaN/Infinity', (outcome, reason) => {
    expect(outcome).toEqual({ ok: false, reason });
  });

  test('never emits a non-finite success across a broad deterministic input grid', () => {
    for (let acute = 0; acute <= 1_000; acute += 25) {
      for (let chronic = 0; chronic <= 1_000; chronic += 25) {
        const outcome = acuteChronicWorkloadRatio(acute, chronic);
        if (outcome.ok) {
          expect(Number.isFinite(outcome.value)).toBe(true);
        } else {
          expect(outcome.reason).toBe('ZERO_CHRONIC_LOAD');
        }
      }
    }
  });
});

describe('versioned formula results', () => {
  test('calculates golden session load with immutable lineage', () => {
    const rpe = observation({
      id: 'rpe-1',
      kind: 'session_rpe',
      unit: 'rpe_0_10',
      value: 7,
    });
    const duration = observation({
      id: 'duration-1',
      kind: 'duration',
      unit: 'minutes',
      value: 60,
    });

    const result = calculateSessionLoad({ rpe, duration, computedAt: COMPUTED_AT });

    expect(result.value).toBe(420);
    expect(result.unit).toBe('au');
    expect(result.formulaId).toBe('MVP-01');
    expect(result.formulaVersion).toBe('1.0.0');
    expect(result.inputObservationIds).toEqual(['rpe-1', 'duration-1']);
    expect(result.provenance).toHaveLength(2);
    expect(result.validation).toEqual({ state: 'valid', hardBlocks: [], warnings: [] });
    expect(result.quality).toEqual({
      confidence: 'HIGH',
      completeness: 1,
      worstSourceQuality: 'verified',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
    expect(Object.isFrozen(result.provenance[0])).toBe(true);
  });

  test('labels manual fallback rather than pretending it is high-confidence sensor data', () => {
    const result = calculateSessionLoad({
      rpe: observation({
        id: 'rpe-manual',
        kind: 'session_rpe',
        unit: 'rpe_0_10',
        value: 5,
        sourceType: 'manual',
        sourceQuality: 'moderate',
      }),
      duration: observation({
        id: 'duration-timer',
        kind: 'duration',
        unit: 'minutes',
        value: 30,
      }),
      computedAt: COMPUTED_AT,
    });

    expect(result.value).toBe(150);
    expect(result.validation.state).toBe('warning');
    expect(result.validation.warnings).toContain('FALLBACK_SOURCE_USED');
    expect(result.quality.confidence).toBe('MODERATE');
  });

  test.each([
    {
      name: 'missing RPE',
      rpe: null,
      duration: 30,
      reason: 'MISSING_RPE',
      state: 'insufficient',
    },
    {
      name: 'missing duration',
      rpe: 5,
      duration: null,
      reason: 'MISSING_DURATION',
      state: 'insufficient',
    },
    {
      name: 'RPE above its explicit scale',
      rpe: 11,
      duration: 30,
      reason: 'RPE_OUT_OF_RANGE',
      state: 'invalid',
    },
    {
      name: 'zero duration',
      rpe: 5,
      duration: 0,
      reason: 'ZERO_ACTIVE_TIME',
      state: 'invalid',
    },
  ])('returns null with reason code for $name', ({ rpe, duration, reason, state }) => {
    const result = calculateSessionLoad({
      rpe: observation({
        id: 'rpe-invalid',
        kind: 'session_rpe',
        unit: 'rpe_0_10',
        value: rpe,
      }),
      duration: observation({
        id: 'duration-invalid',
        kind: 'duration',
        unit: 'minutes',
        value: duration,
      }),
      computedAt: COMPUTED_AT,
    });

    expect(result.value).toBeNull();
    expect(result.unavailableReason).toBe(reason);
    expect(result.validation.state).toBe(state);
    expect(Number.isNaN(result.value)).toBe(false);
  });

  test('blocks cross-organization and cross-athlete input mixing', () => {
    const result = calculateSessionLoad({
      rpe: observation({
        id: 'rpe-scope',
        kind: 'session_rpe',
        unit: 'rpe_0_10',
        value: 5,
        organizationId: 'org-1',
        athleteId: 'athlete-1',
      }),
      duration: observation({
        id: 'duration-scope',
        kind: 'duration',
        unit: 'minutes',
        value: 30,
        organizationId: 'org-2',
        athleteId: 'athlete-2',
      }),
      computedAt: COMPUTED_AT,
    });

    expect(result.value).toBeNull();
    expect(result.validation.hardBlocks).toEqual(expect.arrayContaining([
      'ORGANIZATION_SCOPE_MISMATCH',
      'ATHLETE_SCOPE_MISMATCH',
    ]));
  });

  test('blocks a failed source-quality signal', () => {
    const result = calculateSessionLoad({
      rpe: observation({
        id: 'rpe-failed',
        kind: 'session_rpe',
        unit: 'rpe_0_10',
        value: 5,
        sourceQuality: 'failed',
      }),
      duration: observation({
        id: 'duration-good',
        kind: 'duration',
        unit: 'minutes',
        value: 20,
      }),
      computedAt: COMPUTED_AT,
    });

    expect(result.value).toBeNull();
    expect(result.validation.hardBlocks).toContain('SOURCE_QUALITY_FAIL');
  });

  test('rejects an invalid calculation timestamp instead of creating false lineage', () => {
    const result = calculateSessionLoad({
      rpe: observation({
        id: 'rpe-invalid-time',
        kind: 'session_rpe',
        unit: 'rpe_0_10',
        value: 5,
      }),
      duration: observation({
        id: 'duration-invalid-time',
        kind: 'duration',
        unit: 'minutes',
        value: 20,
      }),
      computedAt: 'not-a-timestamp',
    });

    expect(result.value).toBeNull();
    expect(result.validation.state).toBe('invalid');
    expect(result.validation.hardBlocks).toContain('INVALID_TIMESTAMP');
    expect(result.unavailableReason).toBe('INVALID_TIMESTAMP');
  });

  test('calculates attendance rate and rejects impossible denominators/counts', () => {
    const valid = calculateAttendanceRate({
      scheduled: observation({
        id: 'scheduled',
        kind: 'scheduled_sessions',
        unit: 'count',
        value: 8,
        contextId: 'period-1',
      }),
      attended: observation({
        id: 'attended',
        kind: 'attended_sessions',
        unit: 'count',
        value: 6,
        contextId: 'period-1',
      }),
      computedAt: COMPUTED_AT,
    });
    expect(valid.value).toBe(75);

    const zeroDenominator = calculateAttendanceRate({
      scheduled: observation({
        id: 'scheduled-zero',
        kind: 'scheduled_sessions',
        unit: 'count',
        value: 0,
        contextId: 'period-2',
      }),
      attended: observation({
        id: 'attended-zero',
        kind: 'attended_sessions',
        unit: 'count',
        value: 0,
        contextId: 'period-2',
      }),
      computedAt: COMPUTED_AT,
    });
    expect(zeroDenominator.value).toBeNull();
    expect(zeroDenominator.unavailableReason).toBe('DIV_BY_ZERO');

    const impossible = calculateAttendanceRate({
      scheduled: observation({
        id: 'scheduled-impossible',
        kind: 'scheduled_sessions',
        unit: 'count',
        value: 3,
        contextId: 'period-3',
      }),
      attended: observation({
        id: 'attended-impossible',
        kind: 'attended_sessions',
        unit: 'count',
        value: 4,
        contextId: 'period-3',
      }),
      computedAt: COMPUTED_AT,
    });
    expect(impossible.value).toBeNull();
    expect(impossible.validation.hardBlocks).toContain('ATTENDED_GT_SCHEDULED');
  });

  test('calculates rolling load and EWMA across distinct session contexts', () => {
    const loads = [
      load('load-1', 100, 1),
      load('load-2', 200, 2),
      load('load-3', 300, 3),
      load('load-4', 500, 4),
    ];

    const rolling = calculateRollingLoad({
      loads,
      window: 3,
      computedAt: COMPUTED_AT,
    });
    const smoothed = calculateEwmaLoad({
      loads: loads.slice(0, 3),
      lambda: 0.5,
      computedAt: COMPUTED_AT,
    });

    expect(rolling.value).toBe(1_000 / 3);
    expect(smoothed.value).toBe(225);
    expect(rolling.validation.state).toBe('valid');
    expect(smoothed.validation.state).toBe('valid');
  });

  test('rejects missing and out-of-order load series without filling gaps', () => {
    const missing = calculateEwmaLoad({
      loads: [load('load-1', 100, 1), load('load-gap', null, 2)],
      lambda: 0.2,
      computedAt: COMPUTED_AT,
    });
    expect(missing.value).toBeNull();
    expect(missing.validation.hardBlocks).toContain('INSUFFICIENT_DATA');

    const outOfOrder = calculateRollingLoad({
      loads: [load('later', 100, 3), load('earlier', 100, 2)],
      window: 2,
      computedAt: COMPUTED_AT,
    });
    expect(outOfOrder.value).toBeNull();
    expect(outOfOrder.validation.hardBlocks).toContain('OBSERVATIONS_NOT_CHRONOLOGICAL');
  });

  test('calculates ACWR as information only and requires human review', () => {
    const result = calculateAcuteChronicWorkloadRatio({
      acute: observation({
        id: 'acute',
        kind: 'acute_load',
        unit: 'au',
        value: 500,
        contextId: 'window-1',
      }),
      chronic: observation({
        id: 'chronic',
        kind: 'chronic_load',
        unit: 'au',
        value: 400,
        contextId: 'window-1',
      }),
      computedAt: COMPUTED_AT,
    });

    expect(result.value).toBe(1.25);
    expect(result.humanReviewRequired).toBe(true);

    const noChronicLoad = calculateAcuteChronicWorkloadRatio({
      acute: observation({
        id: 'acute-no-base',
        kind: 'acute_load',
        unit: 'au',
        value: 100,
        contextId: 'window-2',
      }),
      chronic: observation({
        id: 'chronic-zero',
        kind: 'chronic_load',
        unit: 'au',
        value: 0,
        contextId: 'window-2',
      }),
      computedAt: COMPUTED_AT,
    });
    expect(noChronicLoad.value).toBeNull();
    expect(noChronicLoad.unavailableReason).toBe('ZERO_CHRONIC_LOAD');
  });

  test('returns an explicit immutable unsupported result instead of a fabricated number', () => {
    const result = unsupportedFormulaResult({
      formulaId: 'BF-13',
      computedAt: COMPUTED_AT,
    });

    expect(result.value).toBeNull();
    expect(result.validation.state).toBe('unsupported');
    expect(result.unavailableReason).toBe('UNSUPPORTED_FORMULA');
    expect(result.quality.confidence).toBe('INSUFFICIENT');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
