jest.mock('./db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { query, withTransaction } from './db';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import { flagNearMiss, listNearMisses } from './shadowNearMisses';

const mockQuery = jest.mocked(query);
const mockWithTransaction = jest.mocked(withTransaction);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);

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
