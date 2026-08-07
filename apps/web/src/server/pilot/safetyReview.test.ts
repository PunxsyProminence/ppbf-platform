jest.mock('./db', () => ({
  query: jest.fn(),
}));

jest.mock('./trainingHolds', () => ({
  listTrainingHolds: jest.fn(),
}));

jest.mock('./escalationLadder', () => ({
  listEscalations: jest.fn(),
}));

jest.mock('./compliance', () => ({
  getOrganizationViolations: jest.fn(),
}));

import { getOrganizationSafetyReview } from './safetyReview';
import { query } from './db';
import { listTrainingHolds } from './trainingHolds';
import { listEscalations } from './escalationLadder';
import { getOrganizationViolations } from './compliance';

const mockQuery = jest.mocked(query);
const mockListHolds = jest.mocked(listTrainingHolds);
const mockListEscalations = jest.mocked(listEscalations);
const mockGetViolations = jest.mocked(getOrganizationViolations);

const ATHLETES_ROW = [{ athlete_id: 'ath-1', full_name: 'Jordan T.' }];

function hold(overrides: Record<string, unknown> = {}) {
  return {
    hold_id: 'hold-1',
    athlete_id: 'ath-1',
    scope: 'all_training',
    reason_category: 'medical',
    reason_text: 'staff detail',
    athlete_explanation: 'explanation',
    lift_condition_text: '',
    placed_by_account_id: 'acct-coach',
    placed_by_role: 'coach',
    placed_at: '2026-08-01T00:00:00.000Z',
    expires_at: null,
    lifted_by_account_id: null,
    lifted_at: null,
    lift_note: '',
    status: 'active',
    ...overrides,
  };
}

function escalation(overrides: Record<string, unknown> = {}) {
  return {
    escalation_id: 'esc-1',
    source_type: 'near_miss',
    source_id: null,
    athlete_id: 'ath-1',
    severity: 'high',
    reason: 'x',
    escalated_to_role: 'organization_admin',
    triggered_by: 'system',
    triggered_by_account_id: null,
    triggered_by_role: null,
    status: 'open',
    acknowledged_by_account_id: null,
    acknowledged_at: null,
    resolved_by_account_id: null,
    resolved_at: null,
    resolution_note: '',
    metadata: {},
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function violation(overrides: Record<string, unknown> = {}) {
  return {
    violation_id: 'viol-1',
    rule_id: 'rule-1',
    video_session_id: null,
    athlete_id: 'ath-1',
    severity: 'high',
    status: 'new',
    escalation_status: 'pending',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListHolds.mockResolvedValue([]);
  mockListEscalations.mockResolvedValue([]);
  mockGetViolations.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
});

describe('getOrganizationSafetyReview', () => {
  // query() is called twice per review: once for the gate-failure rollup,
  // once for the athlete-name roster read (in that order, per the
  // Promise.all in getOrganizationSafetyReview) -- the once-queue below is
  // ordered to match, gate query first.
  test('active holds are attributed with the athlete name', async () => {
    mockListHolds.mockResolvedValueOnce([hold() as never]);
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce(ATHLETES_ROW);

    const review = await getOrganizationSafetyReview('org-1');

    expect(review.openHolds).toEqual([{ ...hold(), athlete_name: 'Jordan T.' }]);
    expect(mockListHolds).toHaveBeenCalledWith('org-1', { status: 'active' });
  });

  test('resolved escalations are excluded; open and acknowledged are not', async () => {
    mockListEscalations.mockResolvedValueOnce([
      escalation({ escalation_id: 'esc-open', status: 'open' }) as never,
      escalation({ escalation_id: 'esc-ack', status: 'acknowledged' }) as never,
      escalation({ escalation_id: 'esc-resolved', status: 'resolved' }) as never,
    ]);
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce(ATHLETES_ROW);

    const review = await getOrganizationSafetyReview('org-1');

    expect(review.openEscalations.map((e) => e.escalation_id)).toEqual(['esc-open', 'esc-ack']);
  });

  test('resolved and dismissed violations are excluded; new/acknowledged/escalated are not', async () => {
    mockGetViolations.mockResolvedValueOnce([
      violation({ violation_id: 'v-new', status: 'new' }) as never,
      violation({ violation_id: 'v-ack', status: 'acknowledged' }) as never,
      violation({ violation_id: 'v-esc', status: 'escalated' }) as never,
      violation({ violation_id: 'v-resolved', status: 'resolved' }) as never,
      violation({ violation_id: 'v-dismissed', status: 'dismissed' }) as never,
    ]);
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce(ATHLETES_ROW);

    const review = await getOrganizationSafetyReview('org-1');

    expect(review.openViolations.map((v) => v.violation_id).sort()).toEqual(['v-ack', 'v-esc', 'v-new']);
  });

  test('an athlete with no roster row falls back to a null name, not a crash', async () => {
    mockListHolds.mockResolvedValueOnce([hold({ athlete_id: 'ath-unknown' }) as never]);
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const review = await getOrganizationSafetyReview('org-1');

    expect(review.openHolds[0].athlete_name).toBeNull();
  });

  test('the gate-failure query only inner-joins evaluations, excludes passed, and scopes active gates/athletes', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce(ATHLETES_ROW);

    await getOrganizationSafetyReview('org-1');

    const gateCall = mockQuery.mock.calls[0];
    expect(String(gateCall[0])).toContain('g.active_flag = true');
    expect(String(gateCall[0])).toContain("latest.outcome <> 'passed'");
    expect(String(gateCall[0])).toContain('ath.active_flag = true');
    expect(gateCall[1]).toEqual(['org-1']);
  });

  test('an empty organization returns all four lists empty, not an error', async () => {
    await expect(getOrganizationSafetyReview('org-1')).resolves.toEqual({
      openHolds: [],
      failingGates: [],
      openEscalations: [],
      openViolations: [],
    });
  });
});
