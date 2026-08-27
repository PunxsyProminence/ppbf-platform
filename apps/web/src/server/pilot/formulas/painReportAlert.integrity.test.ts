import { emitShadowEvent } from '../shadowEvents';
import { flagNearMiss } from '../shadowNearMisses';
import { alertCoachToPainReport } from './painReportAlert';

jest.mock('../shadowNearMisses', () => ({ flagNearMiss: jest.fn() }));
jest.mock('../shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('../db', () => ({ query: jest.fn() }));

const mockFlagNearMiss = jest.mocked(flagNearMiss);
const mockEmitShadowEvent = jest.mocked(emitShadowEvent);

function painInput(value: number) {
  return {
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    kind: 'pain_report',
    value,
    dimensions: { location: 'Lower back' },
    actorAccountId: 'account-1',
    actorRole: 'athlete',
    contextId: 'pain-context-1',
    observedAt: '2026-08-26T12:00:00.000Z',
  };
}

describe('pain-report execution integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([11, 999, Number.POSITIVE_INFINITY])(
    'refuses invalid positive pain severity %p before any coach-visible record is written',
    async (value) => {
      await expect(alertCoachToPainReport(painInput(value))).rejects.toThrow(
        'Pain report severity must be a finite value from 1 through 10.',
      );
      expect(mockFlagNearMiss).not.toHaveBeenCalled();
      expect(mockEmitShadowEvent).not.toHaveBeenCalled();
    },
  );
});
