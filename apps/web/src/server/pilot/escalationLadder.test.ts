function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import {
  acknowledgeEscalation,
  detectRepeatedPatternEscalations,
  fileEscalation,
  getBoardEscalationSummary,
  listEscalations,
  resolveEscalation,
  shouldAutoEscalateNearMiss,
} from './escalationLadder';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('shouldAutoEscalateNearMiss', () => {
  test.each(['high', 'critical'])('%s escalates', (severity) => {
    expect(shouldAutoEscalateNearMiss(severity as never)).toBe(true);
  });

  test.each(['low', 'moderate'])('%s does not escalate', (severity) => {
    expect(shouldAutoEscalateNearMiss(severity as never)).toBe(false);
  });
});

describe('fileEscalation', () => {
  test('without a client, opens its own transaction', async () => {
    const escalation = await fileEscalation({
      organizationId: 'org-1',
      sourceType: 'near_miss',
      sourceId: 'nm-1',
      athleteId: 'ATH-1',
      severity: 'critical',
      reason: 'Contact without clearance.',
      triggeredBy: 'system',
    });

    expect(currentClient.query).toHaveBeenCalledTimes(1);
    expect(currentClient.query.mock.calls[0][0]).toContain('insert into pilot.safety_escalations');
    expect(escalation.status).toBe('open');
    expect(escalation.escalated_to_role).toBe('organization_admin');
  });

  test('with a client, writes through it instead of opening a new transaction', async () => {
    const suppliedClient = fakeClient();

    await fileEscalation(
      {
        organizationId: 'org-1',
        sourceType: 'safety_gate_evaluation',
        athleteId: 'ATH-1',
        severity: 'high',
        reason: 'Gate flagged.',
        triggeredBy: 'system',
      },
      suppliedClient as never,
    );

    expect(suppliedClient.query).toHaveBeenCalledTimes(1);
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  test('escalatedToRole can be overridden from the organization_admin default', async () => {
    const escalation = await fileEscalation({
      organizationId: 'org-1',
      sourceType: 'pain_report',
      athleteId: 'ATH-1',
      severity: 'critical',
      reason: 'Reported pain 9/10.',
      escalatedToRole: 'coach',
      triggeredBy: 'human',
      triggeredByAccountId: 'acct-1',
      triggeredByRole: 'athlete',
    });

    expect(escalation.escalated_to_role).toBe('coach');
    const [, params] = currentClient.query.mock.calls[0];
    expect(params).toContain('coach');
  });
});

describe('listEscalations', () => {
  test('passes null filters through explicitly rather than undefined, matching the SQL null checks', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listEscalations('org-1');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', null, null]);
  });

  test('scopes to specific athlete ids for a coach', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listEscalations('org-1', { status: 'open', athleteIds: ['ATH-1', 'ATH-2'] });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', 'open', ['ATH-1', 'ATH-2']]);
  });
});

describe('acknowledgeEscalation / resolveEscalation', () => {
  test('acknowledge sets status and the acknowledging account, not a resolution', async () => {
    mockQueryOne.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'acknowledged' });

    await acknowledgeEscalation('org-1', 'esc-1', 'acct-coach-1');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("status = 'acknowledged'");
    expect(params).toEqual(['org-1', 'esc-1', 'acct-coach-1']);
  });

  test('resolve requires a resolution note to be threaded through', async () => {
    mockQueryOne.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'resolved' });

    await resolveEscalation('org-1', 'esc-1', 'acct-admin-1', 'Athlete cleared by physician, note on file.');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("status = 'resolved'");
    expect(params).toEqual(['org-1', 'esc-1', 'acct-admin-1', 'Athlete cleared by physician, note on file.']);
  });

  test('a resolve/acknowledge against another organization or a missing id resolves null, not an error', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(acknowledgeEscalation('org-1', 'esc-does-not-exist', 'acct-1')).resolves.toBeNull();
  });
});

describe('detectRepeatedPatternEscalations', () => {
  test('files a repeated_pattern escalation for a candidate crossing the threshold', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { athlete_id: 'ATH-1', trigger_key: 'contact_observation_without_medical_clearance', occurrence_count: 4, max_severity: 'critical' },
      ]);
    mockQueryOne.mockResolvedValueOnce(null); // no existing open escalation for this athlete+trigger

    const filed = await detectRepeatedPatternEscalations('org-1');

    expect(filed).toHaveLength(1);
    expect(filed[0].source_type).toBe('repeated_pattern');
    expect(filed[0].athlete_id).toBe('ATH-1');
    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });

  test('does not refile when an open repeated_pattern escalation already exists for the same athlete and trigger', async () => {
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ATH-1', trigger_key: 'athlete_pain_report', occurrence_count: 5, max_severity: 'high' },
    ]);
    mockQueryOne.mockResolvedValueOnce({ escalation_id: 'esc-existing' });

    const filed = await detectRepeatedPatternEscalations('org-1');

    expect(filed).toHaveLength(0);
    expect(currentClient.query).not.toHaveBeenCalled();
  });

  test('no candidates crossing the threshold files nothing', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const filed = await detectRepeatedPatternEscalations('org-1');

    expect(filed).toHaveLength(0);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('threshold and window are bounded to sane ranges', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await detectRepeatedPatternEscalations('org-1', { windowDays: 10000, threshold: 1 });

    const [, params] = mockQuery.mock.calls[0];
    // windowDays clamped to 365 max, threshold clamped to 2 min (a
    // "repeated" pattern of one occurrence is not a pattern).
    expect(params).toEqual(['org-1', 365, 2]);
  });
});

describe('getBoardEscalationSummary', () => {
  test('a cohort under the minimum comes back insufficient_data, never a small real number', async () => {
    mockQueryOne.mockResolvedValueOnce({
      open_critical: 3, open_critical_athletes: 2,
      open_high: 0, open_high_athletes: 0,
      open_moderate: 0, open_moderate_athletes: 0,
      open_low: 0, open_low_athletes: 0,
    });

    const summary = await getBoardEscalationSummary('org-1');

    expect(summary.openBySeverity.critical.status).toBe('insufficient_data');
    expect(summary.openBySeverity.critical.count).toBeNull();
    expect(summary.openBySeverity.high.status).toBe('unavailable');
  });

  test('a cohort at or above the minimum reports the real count', async () => {
    mockQueryOne.mockResolvedValueOnce({
      open_critical: 8, open_critical_athletes: 6,
      open_high: 0, open_high_athletes: 0,
      open_moderate: 0, open_moderate_athletes: 0,
      open_low: 0, open_low_athletes: 0,
    });

    const summary = await getBoardEscalationSummary('org-1');

    expect(summary.openBySeverity.critical).toEqual({ status: 'available', count: 8 });
  });

  test('never reads an individual escalation row -- counts only', async () => {
    mockQueryOne.mockResolvedValueOnce({
      open_critical: 0, open_critical_athletes: 0,
      open_high: 0, open_high_athletes: 0,
      open_moderate: 0, open_moderate_athletes: 0,
      open_low: 0, open_low_athletes: 0,
    });

    await getBoardEscalationSummary('org-1');

    const [sql] = mockQueryOne.mock.calls[0];
    expect(String(sql)).not.toMatch(/select\s+\*/i);
    expect(String(sql)).not.toContain('reason');
    expect(String(sql)).not.toContain('athlete_id,');
  });
});
