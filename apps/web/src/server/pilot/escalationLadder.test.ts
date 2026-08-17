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
  fileIncidentReport,
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

describe('fileIncidentReport', () => {
  // Unlike fileEscalation (used by every other source_type), an incident
  // report is idempotent: it goes through its own atomic INSERT ... WHERE
  // NOT EXISTS against queryOne directly, not fileEscalation's
  // withTransaction path. The default here is "no duplicate exists", i.e.
  // the insert lands and RETURNING produces a row.
  beforeEach(() => {
    mockQueryOne.mockResolvedValue({ escalation_id: 'esc-generated' });
  });

  test('files as source_type incident, always human-triggered, with the reporter attributed', async () => {
    const escalation = await fileIncidentReport({
      organizationId: 'org-1',
      athleteId: 'ATH-1',
      severity: 'high',
      reason: 'Athlete sprained an ankle during sparring.',
      reportedByAccountId: 'acct-coach-1',
      reportedByRole: 'coach',
    });

    expect(escalation.source_type).toBe('incident');
    expect(escalation.triggered_by).toBe('human');
    expect(escalation.triggered_by_account_id).toBe('acct-coach-1');
    expect(escalation.triggered_by_role).toBe('coach');
    expect(escalation.source_id).toBeNull();
    const [sql, params] = mockQueryOne.mock.calls[0];
    // source_type is a literal in the SQL text, not a bound param, in this
    // one insert -- it is always exactly 'incident'.
    expect(sql).toContain("'incident'");
    expect(sql).toContain('insert into pilot.safety_escalations');
    expect(params).toContain('acct-coach-1');
    expect(params).toContain('coach');
  });

  test('occurredAt rides in metadata -- there is no dedicated column for it', async () => {
    await fileIncidentReport({
      organizationId: 'org-1',
      athleteId: 'ATH-1',
      severity: 'critical',
      reason: 'Reported a day late.',
      reportedByAccountId: 'acct-coach-1',
      reportedByRole: 'coach',
      occurredAt: '2026-08-05',
    });

    const [, params] = mockQueryOne.mock.calls[0];
    const metadataJson = params.find((p: unknown) => typeof p === 'string' && p.startsWith('{')) as string;
    expect(JSON.parse(metadataJson)).toEqual({ occurred_at: '2026-08-05' });
  });

  test('without occurredAt, metadata is empty', async () => {
    await fileIncidentReport({
      organizationId: 'org-1',
      athleteId: 'ATH-1',
      severity: 'high',
      reason: 'Filed same day.',
      reportedByAccountId: 'acct-coach-1',
      reportedByRole: 'coach',
    });

    const [, params] = mockQueryOne.mock.calls[0];
    const metadataJson = params.find((p: unknown) => typeof p === 'string' && p.startsWith('{')) as string;
    expect(JSON.parse(metadataJson)).toEqual({});
  });

  // Round 9 review: the 'high'/'critical' floor was a TypeScript-only type,
  // with the only actual enforcement living in the route's own allow-list
  // check -- nothing in this function or the database stopped a caller that
  // bypasses TypeScript (or a future caller that never re-validates) from
  // filing a sub-floor severity. Casts past the type on purpose to exercise
  // the runtime guard.
  test('rejects a severity below the floor even past the TypeScript type', async () => {
    await expect(
      fileIncidentReport({
        organizationId: 'org-1',
        athleteId: 'ATH-1',
        severity: 'moderate' as unknown as 'high',
        reason: 'Should never reach the database.',
        reportedByAccountId: 'acct-coach-1',
        reportedByRole: 'coach',
      }),
    ).rejects.toThrow(/severity must be 'high' or 'critical'/);

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  // The idempotency this function exists to add: a double-submit or a
  // client retry within the dedup window must not file a second row for
  // the same real-world event.
  describe('idempotency', () => {
    test('a duplicate within the window returns the EXISTING report, not a new one', async () => {
      const existingReport = {
        escalation_id: 'esc-original',
        source_type: 'incident',
        source_id: null,
        athlete_id: 'ATH-1',
        severity: 'high',
        reason: 'Athlete sprained an ankle during sparring.',
        escalated_to_role: 'organization_admin',
        triggered_by: 'human',
        triggered_by_account_id: 'acct-coach-1',
        triggered_by_role: 'coach',
        status: 'open',
        acknowledged_by_account_id: null,
        acknowledged_at: null,
        resolved_by_account_id: null,
        resolved_at: null,
        resolution_note: '',
        metadata: {},
        created_at: '2026-08-17T00:00:00.000Z',
        updated_at: '2026-08-17T00:00:00.000Z',
      };
      // First call: the guarded INSERT ... WHERE NOT EXISTS matches nothing
      // to insert (a duplicate already exists), so RETURNING produces no
      // row. Second call: the re-read that finds the existing report.
      mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existingReport);

      const result = await fileIncidentReport({
        organizationId: 'org-1',
        athleteId: 'ATH-1',
        severity: 'high',
        reason: 'Athlete sprained an ankle during sparring.',
        reportedByAccountId: 'acct-coach-1',
        reportedByRole: 'coach',
      });

      expect(result).toEqual(existingReport);
      expect(mockQueryOne).toHaveBeenCalledTimes(2);
      const [insertSql] = mockQueryOne.mock.calls[0];
      expect(insertSql).toContain('where not exists');
      const [selectSql] = mockQueryOne.mock.calls[1];
      expect(selectSql).toContain('select escalation_id');
    });

    test('the not-exists check is scoped to org, athlete, reporter, reason, and the dedup window', async () => {
      await fileIncidentReport({
        organizationId: 'org-1',
        athleteId: 'ATH-1',
        severity: 'high',
        reason: 'Athlete sprained an ankle during sparring.',
        reportedByAccountId: 'acct-coach-1',
        reportedByRole: 'coach',
      });

      const [sql] = mockQueryOne.mock.calls[0];
      expect(sql).toContain('organization_id = $1');
      expect(sql).toContain('athlete_id = $3');
      expect(sql).toContain('triggered_by_account_id = $7');
      expect(sql).toContain('reason = $5');
      expect(sql).toContain("interval '1 second'");
    });

    test('surfaces a real error rather than fabricating a report if the duplicate cannot be re-read', async () => {
      mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        fileIncidentReport({
          organizationId: 'org-1',
          athleteId: 'ATH-1',
          severity: 'high',
          reason: 'Athlete sprained an ankle during sparring.',
          reportedByAccountId: 'acct-coach-1',
          reportedByRole: 'coach',
        }),
      ).rejects.toThrow('a duplicate was detected but the existing report could not be re-read');
    });
  });
});

describe('listEscalations', () => {
  test('passes null filters through explicitly rather than undefined, matching the SQL null checks', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listEscalations('org-1');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', null, null, null]);
  });

  test('scopes to specific athlete ids for a coach', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listEscalations('org-1', { status: 'open', athleteIds: ['ATH-1', 'ATH-2'] });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', 'open', ['ATH-1', 'ATH-2'], null]);
  });

  // #198: the coach-scoped list must never carry athlete_voice rows -- the
  // existence of a disclosure-driven escalation is itself information the
  // athlete's coach must not receive through this surface.
  test('excludeAthleteVoice reaches the SQL as a real predicate, not a default', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listEscalations('org-1', { athleteIds: ['ATH-1'], excludeAthleteVoice: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("source_type <> 'athlete_voice'");
    expect(params).toEqual(['org-1', null, ['ATH-1'], true]);
  });
});

describe('acknowledgeEscalation / resolveEscalation', () => {
  test('acknowledge sets status and the acknowledging account, guarded to open rows only', async () => {
    mockQueryOne.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'acknowledged' });

    await acknowledgeEscalation('org-1', 'esc-1', 'acct-coach-1');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("status = 'acknowledged'");
    // The status predicate is what stops a stale page from regressing a
    // resolved record back into the acknowledged queue.
    expect(String(sql)).toContain('status = any($4::text[])');
    expect(params).toEqual(['org-1', 'esc-1', 'acct-coach-1', ['open']]);
  });

  test('resolve threads the note through, guarded to open/acknowledged rows', async () => {
    mockQueryOne.mockResolvedValueOnce({ escalation_id: 'esc-1', status: 'resolved' });

    await resolveEscalation('org-1', 'esc-1', 'acct-admin-1', 'Athlete cleared by physician, note on file.');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain("status = 'resolved'");
    expect(String(sql)).toContain('status = any($5::text[])');
    // nullif keeps an empty-string note from wiping a stored one.
    expect(String(sql)).toContain("coalesce(nullif($4, ''), resolution_note)");
    expect(params).toEqual(['org-1', 'esc-1', 'acct-admin-1', 'Athlete cleared by physician, note on file.', ['open', 'acknowledged']]);
  });

  test('a missing id resolves null: guarded update matches nothing, re-read finds no row', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(acknowledgeEscalation('org-1', 'esc-does-not-exist', 'acct-1')).resolves.toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  test('acknowledging a RESOLVED escalation throws an Unsupported transition instead of regressing it', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null) // guarded update matched nothing
      .mockResolvedValueOnce({ status: 'resolved' }); // the row exists, in a terminal state

    await expect(acknowledgeEscalation('org-1', 'esc-1', 'acct-coach-1')).rejects.toThrow(
      /Unsupported transition: escalation is 'resolved'/,
    );
  });

  test('re-resolving a resolved escalation throws rather than overwriting who closed it', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'resolved' });

    await expect(resolveEscalation('org-1', 'esc-1', 'acct-admin-2', 'second note')).rejects.toThrow(
      /Unsupported transition/,
    );
  });

  test('re-acknowledging throws rather than silently replacing who first saw the red flag', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'acknowledged' });

    await expect(acknowledgeEscalation('org-1', 'esc-1', 'acct-coach-2')).rejects.toThrow(
      /Unsupported transition: escalation is 'acknowledged'/,
    );
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
