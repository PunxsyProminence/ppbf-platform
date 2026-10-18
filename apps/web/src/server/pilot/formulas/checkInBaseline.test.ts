jest.mock('./repository', () => ({
  saveFormulaObservation: jest.fn(),
  getActiveObservationsOfKindInWindow: jest.fn(),
}));
jest.mock('./runner', () => ({ runStoredMvpFormula: jest.fn() }));

import { recordCheckInBaselines } from './checkInBaseline';
import { getActiveObservationsOfKindInWindow, saveFormulaObservation } from './repository';
import { runStoredMvpFormula } from './runner';
import type { NumericObservation } from './types';

const mockSave = jest.mocked(saveFormulaObservation);
const mockWindow = jest.mocked(getActiveObservationsOfKindInWindow);
const mockRun = jest.mocked(runStoredMvpFormula);

function stored(id: string, metricKey: string, unit: string, observedAt: string, contextId = 'check-in:x'): NumericObservation {
  return {
    observationId: id,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId,
    kind: 'numeric',
    value: 1,
    unit: unit as NumericObservation['unit'],
    dimensions: { metricKey },
    observedAt,
    source: { type: 'manual', quality: 'moderate', referenceId: 'r' },
  };
}

const AT = '2026-10-17T12:00:00.000Z';

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockImplementation(async (input) => stored(`new-${input.dimensions?.metricKey}`, String(input.dimensions?.metricKey), input.unit, AT));
  mockRun.mockResolvedValue({ results: [] });
});

test('answered items become numeric observations keyed by the check-in; blanks write nothing', async () => {
  mockWindow.mockResolvedValue([]);
  await recordCheckInBaselines({
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    checkInId: 'ci-1',
    observedAt: AT,
    accountId: 'acct-1',
    values: { sleep_hours: 7.5, energy: null, soreness: 2 },
  });

  expect(mockSave.mock.calls.map(([input]) => [input.kind, input.value, input.unit, input.dimensions, input.idempotencyKey, input.contextId])).toEqual([
    ['numeric', 7.5, 'hours', { metricKey: 'sleep_hours' }, 'check-in:ci-1:sleep_hours', 'check-in:ci-1'],
    ['numeric', 2, 'rating_1_5', { metricKey: 'soreness' }, 'check-in:ci-1:soreness', 'check-in:ci-1'],
  ]);
});

test('MVP-09 runs per item over the same item\'s earlier values in the window, current last', async () => {
  mockWindow.mockResolvedValue([
    stored('old-sleep', 'sleep_hours', 'hours', '2026-10-10T12:00:00.000Z'),
    stored('old-energy', 'energy', 'rating_1_5', '2026-10-11T12:00:00.000Z'),
    // Same metric, but not from a check-in: never part of the baseline.
    stored('posted-sleep', 'sleep_hours', 'hours', '2026-10-12T12:00:00.000Z', 'sparring_1'),
    stored('new-sleep_hours', 'sleep_hours', 'hours', AT),
  ]);
  await recordCheckInBaselines({
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    checkInId: 'ci-1',
    observedAt: AT,
    accountId: 'acct-1',
    values: { sleep_hours: 8 },
  });

  expect(mockWindow).toHaveBeenCalledWith({
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    kind: 'numeric',
    observedAfter: '2026-09-19T12:00:00.000Z',
    observedAtOrBefore: AT,
  });
  expect(mockRun).toHaveBeenCalledWith({
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    formulaId: 'MVP-09',
    observationIds: ['old-sleep', 'new-sleep_hours'],
    parameters: { metricKey: 'sleep_hours', windowDays: 28, minimumHistory: 7, adequateHistory: 14, sdFloor: 0.5 },
    policyVersion: 'check-in-baseline-2026-10-17',
  });
});
