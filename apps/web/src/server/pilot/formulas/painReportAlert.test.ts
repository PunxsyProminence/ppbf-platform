import { emitShadowEvent } from '../shadowEvents';
import { flagNearMiss } from '../shadowNearMisses';
import { alertCoachToPainReport, isPainReport } from './painReportAlert';

jest.mock('../shadowNearMisses', () => ({ flagNearMiss: jest.fn() }));
jest.mock('../shadowEvents', () => ({ emitShadowEvent: jest.fn() }));

const mockFlagNearMiss = jest.mocked(flagNearMiss);
const mockEmitShadowEvent = jest.mocked(emitShadowEvent);

function alertInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    kind: 'pain_report',
    value: 5,
    dimensions: { location: 'Lower back', painType: 'Sharp' },
    actorAccountId: 'account-1',
    actorRole: 'athlete',
    contextId: 'pain_1753900000000',
    observedAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFlagNearMiss.mockResolvedValue({
    near_miss_id: 'near-miss-1',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    decision_id: null,
    description: 'recorded',
    severity: 'high',
    detected_by: 'system',
    detected_by_account_id: 'account-1',
    metadata: {},
    created_at: '2026-07-31T10:00:00.000Z',
  });
  mockEmitShadowEvent.mockResolvedValue(undefined);
});

describe('isPainReport', () => {
  test('a reported severity is a pain report', () => {
    expect(isPainReport('pain_report', 1)).toBe(true);
  });

  test('no pain and no reading are not pain reports', () => {
    expect(isPainReport('pain_report', 0)).toBe(false);
    expect(isPainReport('pain_report', null)).toBe(false);
  });

  test('another observation kind is not a pain report', () => {
    expect(isPainReport('session_rpe', 9)).toBe(false);
  });
});

describe('alertCoachToPainReport', () => {
  test('writes both coach-visible records for a reported pain', async () => {
    const outcome = await alertCoachToPainReport(alertInput());

    expect(outcome).toEqual({ raised: true, severity: 'high' });
    expect(mockFlagNearMiss).toHaveBeenCalledTimes(1);
    expect(mockEmitShadowEvent).toHaveBeenCalledTimes(1);

    const nearMiss = mockFlagNearMiss.mock.calls[0][0];
    expect(nearMiss.description).toContain('Lower back');
    expect(nearMiss.description).toContain('5/10');
    expect(nearMiss.metadata).toEqual(expect.objectContaining({
      trigger: 'athlete_pain_report',
      severity_1_10: 5,
    }));
    // The review state a coach reads off the feed is derived from this name.
    expect(mockEmitShadowEvent.mock.calls[0][0].eventName).toContain('PENDING');
  });

  // A pain report never sorts below the routine end of the queue.
  test.each([
    [1, 'moderate'],
    [3, 'moderate'],
    [4, 'high'],
    [6, 'high'],
    [7, 'critical'],
    [10, 'critical'],
  ])('severity %i is banded as %s', async (value, severity) => {
    const outcome = await alertCoachToPainReport(alertInput({ value }));
    expect(outcome.severity).toBe(severity);
  });

  test('raises nothing for an observation that is not a pain report', async () => {
    const outcome = await alertCoachToPainReport(alertInput({ kind: 'session_rpe', value: 9 }));

    expect(outcome).toEqual({ raised: false });
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    expect(mockEmitShadowEvent).not.toHaveBeenCalled();
  });

  test('surfaces a failure to record rather than reporting success', async () => {
    mockFlagNearMiss.mockRejectedValueOnce(new Error('near miss store unavailable'));

    await expect(alertCoachToPainReport(alertInput())).rejects.toThrow('near miss store unavailable');
    expect(mockEmitShadowEvent).not.toHaveBeenCalled();
  });
});
