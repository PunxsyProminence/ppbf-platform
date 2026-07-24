jest.mock('../db', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('./repository', () => ({
  getActiveFormulaObservationsByIds: jest.fn(),
  saveFormulaResultsWithClient: jest.fn(),
  findFormulaResultsUsingObservation: jest.fn(),
}));
jest.mock('./baseline', () => {
  const actual = jest.requireActual('./baseline');
  return {
    ...actual,
    savePersonalBaselineSnapshotWithClient: jest.fn(),
  };
});

import { withTransaction } from '../db';
import { savePersonalBaselineSnapshotWithClient } from './baseline';
import { calculatePunchOutput } from './engine';
import {
  findFormulaResultsUsingObservation,
  getActiveFormulaObservationsByIds,
  saveFormulaResultsWithClient,
} from './repository';
import {
  FormulaExecutionError,
  recalculateForSupersededObservation,
  runStoredMvpFormula,
} from './runner';
import type { FormulaUnit, NumericObservation, ObservationKind } from './types';

const mockGetObservations = jest.mocked(getActiveFormulaObservationsByIds);
const mockSaveResults = jest.mocked(saveFormulaResultsWithClient);
const mockFindResults = jest.mocked(findFormulaResultsUsingObservation);
const mockSaveBaseline = jest.mocked(savePersonalBaselineSnapshotWithClient);
const mockWithTransaction = jest.mocked(withTransaction);
const transactionClient = { query: jest.fn() };

function observation<TKind extends ObservationKind, TUnit extends FormulaUnit>(input: {
  id: string;
  kind: TKind;
  unit: TUnit;
  value: number | null;
  observedAt?: string;
  contextId?: string;
  dimensions?: Readonly<Record<string, string | number | boolean | null>>;
}): NumericObservation<TKind, TUnit> {
  return {
    observationId: input.id,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: input.contextId ?? 'session-1',
    kind: input.kind,
    value: input.value,
    unit: input.unit,
    dimensions: input.dimensions ?? {},
    observedAt: input.observedAt ?? '2026-07-28T10:00:00.000Z',
    source: {
      type: 'system_timer',
      quality: 'verified',
      referenceId: `${input.id}-source`,
    },
  };
}

describe('stored MVP formula runner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithTransaction.mockImplementation(async (callback) => callback(transactionClient as never));
    mockSaveResults.mockImplementation(async (_client, results) => [...results]);
    mockSaveBaseline.mockImplementation(async (_client, snapshot) => snapshot);
  });

  test('loads scoped inputs, produces both MVP-02 outputs, and persists them once', async () => {
    const inputs = [
      observation({ id: 'punches', kind: 'punch_count', unit: 'count', value: 120 }),
      observation({ id: 'rounds', kind: 'round_count', unit: 'count', value: 3 }),
      observation({ id: 'active', kind: 'active_time', unit: 'minutes', value: 6 }),
    ];
    mockGetObservations.mockResolvedValue(inputs);

    const output = await runStoredMvpFormula({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-02',
      observationIds: inputs.map((item) => item.observationId),
      computedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(mockGetObservations).toHaveBeenCalledWith({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      observationIds: ['punches', 'rounds', 'active'],
    });
    expect(output.results.map((result) => [result.outputKey, result.value])).toEqual([
      ['punches_per_round', 40],
      ['punches_per_active_minute', 20],
    ]);
    expect(mockSaveResults).toHaveBeenCalledTimes(1);
    expect(mockSaveResults).toHaveBeenCalledWith(transactionClient, expect.any(Array));
  });

  test('requires an explicit baseline policy and persists its immutable snapshot', async () => {
    const values = [8, 9, 10, 11, 12].map((value, index) => observation({
      id: `metric-${index}`,
      kind: 'numeric' as const,
      unit: 'count' as const,
      value,
      observedAt: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
      contextId: `metric-context-${index}`,
      dimensions: { metricKey: 'jab_count' },
    }));
    mockGetObservations.mockResolvedValue(values);

    await expect(runStoredMvpFormula({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-09',
      observationIds: values.map((item) => item.observationId),
    })).rejects.toBeInstanceOf(FormulaExecutionError);
    expect(mockSaveBaseline).not.toHaveBeenCalled();

    const output = await runStoredMvpFormula({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-09',
      observationIds: values.map((item) => item.observationId),
      policyVersion: 'baseline-v1',
      parameters: {
        metricKey: 'jab_count',
        windowSize: 8,
        minimumHistory: 4,
        adequateHistory: 8,
      },
      computedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(mockSaveBaseline).toHaveBeenCalledWith(transactionClient, expect.objectContaining({
      metricKey: 'jab_count',
      historyStatus: 'building',
      observationIds: ['metric-0', 'metric-1', 'metric-2', 'metric-3'],
    }));
    expect(output.results.map((result) => result.outputKey)).toEqual([
      'raw_change',
      'standardized_change',
    ]);
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSaveResults).toHaveBeenCalledWith(transactionClient, expect.any(Array));
  });

  test('keeps a zero-history baseline in the current metric unit and writes it atomically', async () => {
    const current = observation({
      id: 'metric-current-only',
      kind: 'numeric',
      unit: 'count',
      value: 12,
      dimensions: { metricKey: 'jab_count' },
    });
    mockGetObservations.mockResolvedValue([current]);

    const output = await runStoredMvpFormula({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-09',
      observationIds: [current.observationId],
      policyVersion: 'baseline-v1',
      parameters: {
        metricKey: 'jab_count',
        windowSize: 8,
        minimumHistory: 4,
        adequateHistory: 8,
      },
    });

    expect(output.baselineSnapshot).toEqual(expect.objectContaining({
      unit: 'count',
      historyStatus: 'insufficient_history',
      baselineMean: null,
      baselineSampleSd: null,
    }));
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSaveBaseline).toHaveBeenCalledWith(transactionClient, expect.any(Object));
    expect(mockSaveResults).toHaveBeenCalledWith(transactionClient, expect.any(Array));
  });

  test('propagates a result-write failure from the single baseline/result transaction', async () => {
    const values = [8, 9, 10, 11, 12].map((value, index) => observation({
      id: `atomic-${index}`,
      kind: 'numeric' as const,
      unit: 'count' as const,
      value,
      observedAt: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
      contextId: `atomic-context-${index}`,
      dimensions: { metricKey: 'jab_count' },
    }));
    mockGetObservations.mockResolvedValue(values);
    mockSaveResults.mockRejectedValueOnce(new Error('result write failed'));

    await expect(runStoredMvpFormula({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-09',
      observationIds: values.map((item) => item.observationId),
      policyVersion: 'baseline-v1',
      parameters: {
        metricKey: 'jab_count',
        windowSize: 8,
        minimumHistory: 4,
        adequateHistory: 8,
      },
    })).rejects.toThrow('result write failed');
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockSaveBaseline).toHaveBeenCalledWith(transactionClient, expect.any(Object));
    expect(mockSaveResults).toHaveBeenCalledWith(transactionClient, expect.any(Array));
  });

  test('deduplicates multi-output history when recalculating a superseded observation', async () => {
    const oldPunches = observation({
      id: 'punches-old',
      kind: 'punch_count',
      unit: 'count',
      value: 100,
    });
    const replacement = observation({
      id: 'punches-new',
      kind: 'punch_count',
      unit: 'count',
      value: 120,
    });
    const rounds = observation({
      id: 'rounds',
      kind: 'round_count',
      unit: 'count',
      value: 3,
    });
    const active = observation({
      id: 'active',
      kind: 'active_time',
      unit: 'minutes',
      value: 6,
    });
    const priorResults = calculatePunchOutput({
      punches: oldPunches,
      rounds,
      activeTime: active,
      computedAt: '2026-07-27T12:00:00.000Z',
    });
    mockFindResults.mockResolvedValue([...priorResults]);
    mockGetObservations.mockResolvedValue([replacement, rounds, active]);

    const recalculated = await recalculateForSupersededObservation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      supersededObservationId: 'punches-old',
      replacementObservationId: 'punches-new',
      computedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(mockGetObservations).toHaveBeenCalledTimes(1);
    expect(mockGetObservations).toHaveBeenCalledWith(expect.objectContaining({
      observationIds: ['punches-new', 'rounds', 'active'],
    }));
    expect(recalculated.map((result) => result.value)).toEqual([40, 20]);
    expect(recalculated.every(
      (result) => result.inputObservationIds.includes('punches-new'),
    )).toBe(true);
  });
});
