jest.mock('./db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { query, withTransaction } from './db';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import { evaluateDecisionOutcome, listDecisionOutcomes } from './shadowDecisionOutcomes';

const mockQuery = jest.mocked(query);
const mockWithTransaction = jest.mocked(withTransaction);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);

function outcomeRow(overrides: Record<string, unknown> = {}) {
  return {
    outcome_id: 'outcome-1',
    organization_id: 'org-1',
    decision_id: 'dec-1',
    observation_ids: ['obs-1', 'obs-2'],
    match_state: 'match',
    notes: 'Contact exposure ratio returned to baseline as expected.',
    evaluated_by_account_id: 'coach-1',
    evaluated_at: '2026-08-03T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
});

describe('evaluateDecisionOutcome', () => {
  test('rejects a decisionId that does not exist in this organization scope', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await expect(evaluateDecisionOutcome({
      organizationId: 'org-1',
      decisionId: 'missing-decision',
      observationIds: ['obs-1'],
      matchState: 'match',
      evaluatedByAccountId: 'coach-1',
      evaluatedByRole: 'coach',
    })).rejects.toThrow('Decision not found in this organization scope.');

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  test('records the outcome and writes an audit entry once the decision is confirmed to exist', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ decision_id: 'dec-1' }] })
      .mockResolvedValueOnce({ rows: [outcomeRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await evaluateDecisionOutcome({
      organizationId: 'org-1',
      decisionId: 'dec-1',
      observationIds: ['obs-1', 'obs-2'],
      matchState: 'match',
      notes: 'Contact exposure ratio returned to baseline as expected.',
      evaluatedByAccountId: 'coach-1',
      evaluatedByRole: 'coach',
    });

    expect(result.match_state).toBe('match');
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const [, auditInput] = mockWriteAudit.mock.calls[0];
    expect(auditInput.entityType).toBe('outcome');
    expect(auditInput.afterState).toEqual({ decisionId: 'dec-1', matchState: 'match' });
  });
});

describe('listDecisionOutcomes', () => {
  test('scopes to the given organization and decision, newest first', async () => {
    mockQuery.mockResolvedValueOnce([outcomeRow()]);

    const results = await listDecisionOutcomes('org-1', 'dec-1');

    expect(results).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('order by evaluated_at desc');
    expect(params).toEqual(['org-1', 'dec-1']);
  });
});
