jest.mock('../db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

import { query, withTransaction } from '../db';
import { calculateSessionLoad } from './engine';
import { deterministicKey } from './identity';
import {
  FormulaRepositoryError,
  getActiveFormulaObservationsByIds,
  listActiveFormulaResults,
  saveFormulaObservation,
  saveFormulaResults,
} from './repository';
import type { FormulaResult } from './types';

const mockQuery = jest.mocked(query);
const mockWithTransaction = jest.mocked(withTransaction);

function observationRow(overrides: Record<string, unknown> = {}) {
  return {
    observation_id: deterministicKey('observation', {
      organizationId: 'org-1',
      idempotencyKey: 'idem-1',
    }),
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    context_id: 'session-1',
    observation_kind: 'session_rpe',
    numeric_value: '5',
    unit: 'rpe_0_10',
    dimensions: {},
    observed_at: '2026-07-28T10:00:00.000Z',
    source_type: 'manual',
    source_quality: 'moderate',
    source_reference_id: 'source-1',
    source_quality_notes: null,
    idempotency_key: 'idem-1',
    supersedes_observation_id: null,
    ...overrides,
  };
}

function newObservation(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: 'session-1',
    kind: 'session_rpe' as const,
    value: 5,
    unit: 'rpe_0_10' as const,
    dimensions: {},
    observedAt: '2026-07-28T10:00:00.000Z',
    source: {
      type: 'manual' as const,
      quality: 'moderate' as const,
      referenceId: 'source-1',
    },
    idempotencyKey: 'idem-1',
    createdByAccountId: 'account-1',
    ...overrides,
  };
}

function resultFixture(): FormulaResult {
  const common = {
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: 'session-1',
    observedAt: '2026-07-28T10:00:00.000Z',
    source: {
      type: 'system_timer' as const,
      quality: 'verified' as const,
      referenceId: 'timer-source',
    },
  };
  return calculateSessionLoad({
    formulaId: 'MVP-01',
    rpe: {
      observationId: 'rpe-1',
      kind: 'session_rpe',
      unit: 'rpe_0_10',
      value: 5,
      ...common,
    },
    duration: {
      observationId: 'duration-1',
      kind: 'duration',
      unit: 'minutes',
      value: 30,
      ...common,
    },
    computedAt: '2026-07-28T12:00:00.000Z',
  });
}

function resultRow(result: FormulaResult, overrides: Record<string, unknown> = {}) {
  return {
    result_id: result.resultId,
    calculation_key: result.calculationKey,
    formula_id: result.formulaId,
    formula_version: result.formulaVersion,
    output_key: result.outputKey,
    policy_version: result.policyVersion,
    parameters: result.parameters,
    organization_id: result.organizationId,
    athlete_id: result.athleteId,
    context_id: result.contextId,
    numeric_value: result.value,
    unit: result.unit,
    computed_at: result.computedAt,
    input_observation_ids: [...result.inputObservationIds],
    provenance: result.provenance,
    validation_state: result.validation.state,
    hard_blocks: [...result.validation.hardBlocks],
    warnings: [...result.validation.warnings],
    confidence: result.quality.confidence,
    completeness: result.quality.completeness,
    worst_source_quality: result.quality.worstSourceQuality,
    unavailable_reason: result.unavailableReason,
    human_review_required: result.humanReviewRequired,
    ...overrides,
  };
}

describe('formula repository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('persists an organization-scoped observation with a deterministic id', async () => {
    const row = observationRow();
    const clientQuery = jest.fn().mockResolvedValue({ rows: [row] });
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const saved = await saveFormulaObservation(newObservation());

    expect(saved.observationId).toBe(row.observation_id);
    expect(saved.organizationId).toBe('org-1');
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(String(clientQuery.mock.calls[0][0])).toContain('on conflict do nothing');
    expect(clientQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([
      row.observation_id,
      'org-1',
      'athlete-1',
      'idem-1',
      'account-1',
    ]));
  });

  test('replays an identical idempotency key and rejects a different payload', async () => {
    const row = observationRow();
    const replayClient = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    mockWithTransaction.mockImplementationOnce(async (callback) => callback({
      query: replayClient,
    } as never));

    await expect(saveFormulaObservation(newObservation())).resolves.toMatchObject({
      observationId: row.observation_id,
      value: 5,
    });

    const conflictClient = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    mockWithTransaction.mockImplementationOnce(async (callback) => callback({
      query: conflictClient,
    } as never));
    await expect(saveFormulaObservation(newObservation({ value: 6 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  test('does not supersede a missing or out-of-scope athlete observation', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    await expect(saveFormulaObservation(newObservation({
      idempotencyKey: 'replacement-1',
      supersedesObservationId: 'outside-scope',
    }))).rejects.toEqual(expect.objectContaining({
      code: 'OBSERVATION_NOT_FOUND',
    }));
    expect(clientQuery.mock.calls[0][1]).toEqual([
      'org-1',
      'athlete-1',
      'outside-scope',
    ]);
  });

  test('loads only active observations in exact organization and athlete scope', async () => {
    const row = observationRow();
    mockQuery.mockResolvedValue([row] as never);

    const observations = await getActiveFormulaObservationsByIds({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      observationIds: [row.observation_id],
    });

    expect(observations).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('successor.supersedes_observation_id = o.observation_id'),
      ['org-1', 'athlete-1', [row.observation_id]],
    );

    mockQuery.mockResolvedValueOnce([] as never);
    await expect(getActiveFormulaObservationsByIds({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      observationIds: ['not-visible'],
    })).rejects.toEqual(expect.objectContaining({
      code: 'OBSERVATION_NOT_FOUND',
    }));
  });

  test('persists and exactly replays immutable formula results', async () => {
    const result = resultFixture();
    const row = resultRow(result);
    const insertClient = jest.fn().mockResolvedValue({ rows: [row] });
    mockWithTransaction.mockImplementationOnce(async (callback) => callback({
      query: insertClient,
    } as never));
    await expect(saveFormulaResults([result])).resolves.toEqual([
      expect.objectContaining({
        calculationKey: result.calculationKey,
        value: 150,
      }),
    ]);
    expect(insertClient.mock.calls[0][1]).toEqual(expect.arrayContaining([
      result.resultId,
      result.calculationKey,
      'MVP-01',
      'value',
      '1.0.0',
    ]));

    const replayClient = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    mockWithTransaction.mockImplementationOnce(async (callback) => callback({
      query: replayClient,
    } as never));
    await expect(saveFormulaResults([{
      ...result,
      computedAt: '2026-07-29T12:00:00.000Z',
    }])).resolves.toEqual([
      expect.objectContaining({ computedAt: result.computedAt }),
    ]);

    const conflictClient = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resultRow(result, { numeric_value: 999 })] });
    mockWithTransaction.mockImplementationOnce(async (callback) => callback({
      query: conflictClient,
    } as never));
    await expect(saveFormulaResults([result])).rejects.toEqual(expect.objectContaining({
      code: 'IDEMPOTENCY_CONFLICT',
    }));
  });

  test('rejects mixed-athlete writes and filters superseded inputs from reads', async () => {
    const result = resultFixture();
    await expect(saveFormulaResults([
      result,
      {
        ...result,
        resultId: 'other-result',
        calculationKey: 'other-calculation',
        athleteId: 'athlete-2',
      },
    ])).rejects.toBeInstanceOf(FormulaRepositoryError);
    expect(mockWithTransaction).not.toHaveBeenCalled();

    mockQuery.mockResolvedValue([resultRow(result)] as never);
    await listActiveFormulaResults({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-01',
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('successor.supersedes_observation_id = input_id'),
      ['org-1', 'athlete-1', 'MVP-01', 50],
    );
  });
});
