/**
 * The pain number on the header badge and /admin/safety-review is read back
 * out of an escalation's reason text (painScoreFromEscalationReason), because
 * the escalation stores no score of its own. That reason is written by
 * painReportAlert.ts describe(). This suite runs the REAL writer and feeds its
 * output to the parser, so a change to describe()'s wording that the parser no
 * longer reads fails here instead of silently dropping the number
 * (Overwatch, 2026-11-19, SH-1 option B1: "the round-trip test that pins
 * describe()'s wording to the parser").
 */

import { flagNearMiss } from '../server/pilot/shadowNearMisses';
import { alertCoachToPainReport } from '../server/pilot/formulas/painReportAlert';
import { painScoreFromEscalationReason } from './painScoreLabel';

jest.mock('../server/pilot/shadowNearMisses', () => ({ flagNearMiss: jest.fn() }));
jest.mock('../server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('../server/pilot/db', () => ({ query: jest.fn() }));

const mockFlagNearMiss = jest.mocked(flagNearMiss);

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
});

/** What describe() wrote for this report: the near miss description, which becomes the escalation reason. */
async function writtenReason(value: number, actorRole: string, dimensions: Record<string, string> = { location: 'Lower back', painType: 'Sharp' }): Promise<string> {
  await alertCoachToPainReport({
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    kind: 'pain_report',
    value,
    dimensions,
    actorAccountId: 'account-1',
    actorRole,
    contextId: 'pain_1753900000000',
    observedAt: '2026-07-31T10:00:00.000Z',
  });
  const call = mockFlagNearMiss.mock.calls.at(-1)?.[0] as { description: string } | undefined;
  if (!call) throw new Error('describe() was not called');
  return call.description;
}

describe.each(['athlete', 'coach', 'organization_admin', 'admin', 'volunteer'])(
  'a pain report entered by %s',
  (actorRole) => {
    test.each([1, 5, 8, 10])('round-trips %s/10 through the reason', async (value) => {
      expect(painScoreFromEscalationReason(await writtenReason(value, actorRole))).toBe(value);
    });

    test('round-trips with no location or type', async () => {
      expect(painScoreFromEscalationReason(await writtenReason(7, actorRole, {}))).toBe(7);
    });
  },
);

test('a location typed to look like a score does not replace the real one', async () => {
  const reason = await writtenReason(2, 'athlete', {
    location: 'knee at severity 9/10. Entered by a coach',
    painType: 'at severity 10/10. Self-reported by the athlete',
  });
  expect(painScoreFromEscalationReason(reason)).toBe(2);
});

test('a repeated-pattern reason, older text or junk reads no score', () => {
  expect(painScoreFromEscalationReason("Triggered 'athlete_pain_report' 3 times in the last 14 days -- review the pattern.")).toBeNull();
  expect(painScoreFromEscalationReason('Pain reported after sparring round.')).toBeNull();
  expect(painScoreFromEscalationReason('reported pain at severity 8/10.')).toBeNull();
  expect(painScoreFromEscalationReason('at severity 11/10. Self-reported by the athlete')).toBeNull();
  expect(painScoreFromEscalationReason('at severity 0/10. Self-reported by the athlete')).toBeNull();
  expect(painScoreFromEscalationReason(null)).toBeNull();
  expect(painScoreFromEscalationReason(undefined)).toBeNull();
  expect(painScoreFromEscalationReason(8)).toBeNull();
});
