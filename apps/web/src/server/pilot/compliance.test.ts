function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import { createComplianceViolation, escalateViolation, getComplianceRulesByCategory } from './compliance';
import { query } from './db';
import { jsonError } from './http';

const mockQuery = query as jest.Mock;

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('escalateViolation', () => {
  test('files the escalation and moves the violation in one transaction', async () => {
    await escalateViolation({
      organizationId: 'org-1',
      violationId: 'v1',
      escalatedByAccountId: 'acct-1',
      escalatedToRole: 'board',
      escalationReason: 'Repeat safety violation',
    });

    // Both writes go through the transaction client, so a failure between them
    // cannot leave an escalation row against a violation still marked 'new'.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(currentClient.query).toHaveBeenCalledTimes(2);
    expect(currentClient.query.mock.calls[0][0]).toContain('insert into pilot.violation_escalations');

    const [updateSql, updateParams] = currentClient.query.mock.calls[1];
    expect(updateSql).toContain('update pilot.compliance_violations');
    expect(updateParams).toEqual(['v1', 'org-1']);
  });
});

describe('createComplianceViolation', () => {
  function params(severity: string) {
    return {
      organizationId: 'org-1',
      ruleId: 'rule-1',
      videoSessionId: null,
      athleteId: 'ath-1',
      detectedByAccountId: 'acct-1',
      severity,
      details: {},
    };
  }

  test.each(['critical', 'high', 'medium', 'low'])('accepts the %s severity', async (severity) => {
    mockQuery.mockResolvedValueOnce([{ violation_id: 'v1' }]);

    await expect(createComplianceViolation(params(severity))).resolves.toEqual({ violation_id: 'v1' });
  });

  // The column has no check constraint, so anything stored outside the four
  // buckets is counted by nothing in getOrganizationViolationSummary and shows
  // up as a violation with no severity anywhere it is ranked.
  test('refuses a severity outside the vocabulary before writing anything', async () => {
    await expect(createComplianceViolation(params('URGENT!!'))).rejects.toThrow('Unsupported severity');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('reports the refusal as a 400, not a masked 500', async () => {
    const refusal = await createComplianceViolation(params('URGENT!!')).catch((error) => error);

    expect(jsonError(refusal).status).toBe(400);
  });
});

describe('getComplianceRulesByCategory', () => {
  // 'medium' > 'critical' alphabetically, so ordering on the raw text column
  // put the least severe rules at the top of the compliance centre.
  test('ranks severity explicitly rather than sorting the text column', async () => {
    await getComplianceRulesByCategory('org-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('order by severity desc');
    expect(sql).toContain("when 'critical' then 1");
    expect(sql).toContain("when 'low' then 4");
  });
});
