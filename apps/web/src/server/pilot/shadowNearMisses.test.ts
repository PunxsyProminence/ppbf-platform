jest.mock('./db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));
jest.mock('./escalationLadder', () => ({
  fileEscalation: jest.fn().mockResolvedValue(undefined),
  shouldAutoEscalateNearMiss: jest.fn((severity: string) => severity === 'high' || severity === 'critical'),
}));

import { query, withTransaction } from './db';
import { fileEscalation } from './escalationLadder';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import { findNearMissByTriggerContext, flagNearMiss, listNearMisses } from './shadowNearMisses';

const mockQuery = jest.mocked(query);
const mockWithTransaction = jest.mocked(withTransaction);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);
const mockFileEscalation = jest.mocked(fileEscalation);

function nearMissRow(overrides: Record<string, unknown> = {}) {
  return {
    near_miss_id: 'nm-1',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    decision_id: null,
    description: 'Athlete reported dizziness after sparring but no decision was logged.',
    severity: 'moderate',
    detected_by: 'human',
    detected_by_account_id: 'coach-1',
    metadata: {},
    created_at: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
});

describe('flagNearMiss', () => {
  // This previously asserted detected_by was hardcoded to the literal 'human' in
  // the SQL. That invariant was relaxed deliberately, not accidentally: the
  // contact-clearance gate needs to record a system detection, and it is a
  // deterministic rule rather than the heuristic that originally kept
  // system-detected flagging out of this module. What still has to hold is that
  // every existing caller, none of which passes detectedBy, keeps getting
  // 'human' -- so the default is asserted rather than the literal.
  test('defaults detected_by to human, so existing callers are unchanged', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [nearMissRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await flagNearMiss({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      description: 'Athlete reported dizziness after sparring but no decision was logged.',
      severity: 'moderate',
      detectedByAccountId: 'coach-1',
      detectedByRole: 'coach',
    });

    expect(result.detected_by).toBe('human');
    const [, params] = clientQuery.mock.calls[0];
    expect(params[5]).toBe('human');
  });

  test('records a system detection when one is explicitly requested', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [nearMissRow({ detected_by: 'system' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await flagNearMiss({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      description: 'Contact logged for an athlete with no current medical clearance.',
      severity: 'critical',
      detectedByAccountId: 'coach-1',
      detectedByRole: 'coach',
      detectedBy: 'system',
    });

    const [, params] = clientQuery.mock.calls[0];
    expect(params[5]).toBe('system');
  });

  // detected_by is now a bind parameter rather than an inlined literal, so the
  // value must never be interpolated into the statement text -- the database
  // check constraint (system|human) is what rejects anything else.
  test('passes detected_by as a bind parameter, not interpolated SQL', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [nearMissRow({ detected_by: 'system' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await flagNearMiss({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      description: 'Contact logged without clearance.',
      severity: 'critical',
      detectedByAccountId: 'coach-1',
      detectedByRole: 'coach',
      detectedBy: 'system',
    });

    const [sql] = clientQuery.mock.calls[0];
    expect(String(sql)).not.toContain("'system'");
    expect(String(sql)).not.toContain("'human'");
  });

  test('writes an audit entry recording the severity and any linked decision', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [nearMissRow({ decision_id: 'dec-1', severity: 'high' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await flagNearMiss({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      decisionId: 'dec-1',
      description: 'Contact exposure ratio spiked with no reviewed decision.',
      severity: 'high',
      detectedByAccountId: 'coach-1',
      detectedByRole: 'coach',
    });

    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const [, auditInput] = mockWriteAudit.mock.calls[0];
    expect(auditInput.entityType).toBe('near_miss');
    expect(auditInput.afterState).toEqual({ severity: 'high', decisionId: 'dec-1' });
  });

  describe('auto-escalation (capability #194)', () => {
    test.each(['high', 'critical'])('a %s severity near miss escalates automatically', async (severity) => {
      const clientQuery = jest.fn().mockResolvedValue({ rows: [nearMissRow({ severity })] });
      mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

      await flagNearMiss({
        organizationId: 'org-1',
        athleteId: 'athlete-1',
        description: 'Some near miss.',
        severity: severity as 'high' | 'critical',
        detectedByAccountId: 'coach-1',
        detectedByRole: 'coach',
      });

      expect(mockFileEscalation).toHaveBeenCalledTimes(1);
      const [escalationInput, client] = mockFileEscalation.mock.calls[0];
      expect(escalationInput).toMatchObject({
        organizationId: 'org-1',
        sourceType: 'near_miss',
        sourceId: 'nm-1',
        athleteId: 'athlete-1',
        severity,
        triggeredBy: 'system',
      });
      // Passed the same transaction client the near-miss row was written
      // with, not left to open a second, unrelated transaction.
      expect(client).toEqual(expect.objectContaining({ query: clientQuery }));
    });

    test.each(['low', 'moderate'])('a %s severity near miss does not escalate', async (severity) => {
      const clientQuery = jest.fn().mockResolvedValue({ rows: [nearMissRow({ severity })] });
      mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

      await flagNearMiss({
        organizationId: 'org-1',
        athleteId: 'athlete-1',
        description: 'Some near miss.',
        severity: severity as 'low' | 'moderate',
        detectedByAccountId: 'coach-1',
        detectedByRole: 'coach',
      });

      expect(mockFileEscalation).not.toHaveBeenCalled();
    });
  });
});

describe('listNearMisses', () => {
  test('scopes to the given organization and athlete, newest first', async () => {
    mockQuery.mockResolvedValueOnce([nearMissRow(), nearMissRow({ near_miss_id: 'nm-2' })]);

    const results = await listNearMisses('org-1', 'athlete-1');

    expect(results).toHaveLength(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('order by created_at desc');
    expect(params).toEqual(['org-1', 'athlete-1']);
  });
});

describe('findNearMissByTriggerContext', () => {
  test('matches on org + athlete + metadata trigger + context, newest first', async () => {
    mockQuery.mockResolvedValueOnce([nearMissRow({ near_miss_id: 'nm-newest' })]);

    const found = await findNearMissByTriggerContext(
      'org-1',
      'athlete-1',
      'contact_observation_without_medical_clearance',
      'sparring_123',
    );

    expect(found?.near_miss_id).toBe('nm-newest');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("metadata->>'trigger' = $3");
    expect(String(sql)).toContain("metadata->>'context_id' = $4");
    expect(String(sql)).toContain('limit 1');
    expect(params).toEqual(['org-1', 'athlete-1', 'contact_observation_without_medical_clearance', 'sparring_123']);
  });

  test('resolves null when the session has not been flagged before', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(
      findNearMissByTriggerContext('org-1', 'athlete-1', 'trigger-x', 'ctx-x'),
    ).resolves.toBeNull();
  });
});
