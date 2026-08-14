function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import {
  createComplianceViolation,
  escalateViolation,
  getComplianceRulesByCategory,
  getOrganizationViolationSummary,
  transitionComplianceViolation,
} from './compliance';
import { query, queryOne } from './db';
import { jsonError } from './http';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('escalateViolation', () => {
  test('claims the violation first, then files the escalation, in one transaction', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ violation_id: 'v1' }] });

    await escalateViolation({
      organizationId: 'org-1',
      violationId: 'v1',
      escalatedByAccountId: 'acct-1',
      escalatedToRole: 'board',
      escalationReason: 'Repeat safety violation',
    });

    // Both writes go through the transaction client. The guarded UPDATE runs
    // FIRST: a violation the org-scoped CAS never matched must not acquire
    // an escalation row.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(currentClient.query).toHaveBeenCalledTimes(2);

    const [updateSql, updateParams] = currentClient.query.mock.calls[0];
    expect(updateSql).toContain('update pilot.compliance_violations');
    expect(updateSql).toContain("status in ('new', 'acknowledged')");
    expect(updateParams).toEqual(['v1', 'org-1']);

    expect(currentClient.query.mock.calls[1][0]).toContain('insert into pilot.violation_escalations');
  });

  test('a stale, foreign, or missing violation aborts before any escalation row exists', async () => {
    // A violation already resolved or dismissed, a violation_id from another
    // organization, and a typo'd id all arrive identically: zero matched
    // rows. The throw rolls the transaction back, so re-escalating a closed
    // violation by stale click is structurally impossible.
    currentClient.query.mockResolvedValue({ rows: [] });

    await expect(
      escalateViolation({
        organizationId: 'org-1',
        violationId: 'v-resolved',
        escalatedByAccountId: 'acct-1',
        escalatedToRole: 'board',
        escalationReason: 'stale click',
      }),
    ).rejects.toThrow('not in an escalatable state');

    expect(
      currentClient.query.mock.calls.filter(([sql]) => sql.includes('violation_escalations')),
    ).toHaveLength(0);
  });
});

// The lifecycle the status vocabulary declares, made reachable. These pins
// are what fail if someone widens a source-state set, drops the organization
// from a predicate, or lets 'resolved' leave an escalation reading
// in_progress.
describe('transitionComplianceViolation', () => {
  test('acknowledge is a CAS out of new only, org-scoped, touching nothing else', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ violation_id: 'v1', status: 'acknowledged' }] });

    const applied = await transitionComplianceViolation({
      organizationId: 'org-1',
      violationId: 'v1',
      transition: 'acknowledge',
    });

    expect(applied).toBe(true);
    const [sql, params] = currentClient.query.mock.calls[0];
    expect(sql).toContain('where organization_id = $1 and violation_id = $2');
    expect(sql).toContain('status = any($4::text[])');
    expect(params).toEqual(['org-1', 'v1', 'acknowledged', ['new']]);
    // Workflow state only: severity, rule, athlete, evidence, details are
    // never in the SET.
    const setClause = sql.slice(sql.toLowerCase().indexOf('set '), sql.toLowerCase().indexOf('where'));
    for (const forbidden of ['severity', 'rule_id', 'athlete_id', 'evidence', 'details']) {
      expect(setClause).not.toContain(forbidden);
    }
    // Acknowledgement never stamps escalation records.
    expect(
      currentClient.query.mock.calls.filter(([q]) => q.includes('violation_escalations')),
    ).toHaveLength(0);
  });

  test('resolve leaves only from acknowledged or escalated, closes the escalation track, and stamps open escalation rows', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ violation_id: 'v1', status: 'resolved' }] });

    const applied = await transitionComplianceViolation({
      organizationId: 'org-1',
      violationId: 'v1',
      transition: 'resolve',
    });

    expect(applied).toBe(true);
    const [sql, params] = currentClient.query.mock.calls[0];
    expect(params).toEqual(['org-1', 'v1', 'resolved', ['acknowledged', 'escalated']]);
    // status='resolved' with escalation_status still in_progress is the
    // contradictory state this CASE exists to make unrepresentable.
    expect(sql).toMatch(/escalation_status = case\s+when \$3 = 'resolved' and status = 'escalated' then 'resolved'/);

    const [stampSql, stampParams] = currentClient.query.mock.calls[1];
    expect(stampSql).toContain('update pilot.violation_escalations');
    expect(stampSql).toContain('set resolved_at = now()');
    expect(stampSql).toContain('where organization_id = $1 and violation_id = $2 and resolved_at is null');
    expect(stampParams).toEqual(['org-1', 'v1']);
    // History is stamped, never deleted.
    expect(stampSql).not.toContain('delete');
  });

  test('dismiss leaves only from new or acknowledged and never touches escalation records', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ violation_id: 'v1', status: 'dismissed' }] });

    const applied = await transitionComplianceViolation({
      organizationId: 'org-1',
      violationId: 'v1',
      transition: 'dismiss',
    });

    expect(applied).toBe(true);
    const [, params] = currentClient.query.mock.calls[0];
    expect(params).toEqual(['org-1', 'v1', 'dismissed', ['new', 'acknowledged']]);
    expect(
      currentClient.query.mock.calls.filter(([q]) => q.includes('violation_escalations')),
    ).toHaveLength(0);
    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });

  test('a stale state, foreign org, or missing row reports false and writes nothing further', async () => {
    // resolved -> acknowledged, dismissed -> resolved, a second concurrent
    // click, and a cross-org id all arrive as the same zero-row CAS miss.
    currentClient.query.mockResolvedValue({ rows: [] });

    const applied = await transitionComplianceViolation({
      organizationId: 'org-1',
      violationId: 'v-decided',
      transition: 'resolve',
    });

    expect(applied).toBe(false);
    expect(currentClient.query).toHaveBeenCalledTimes(1);
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

describe('getOrganizationViolationSummary', () => {
  function summaryRow(overrides: Record<string, number> = {}) {
    return {
      total: 14,
      total_athletes: 9,
      critical: 1,
      critical_athletes: 1,
      high: 13,
      high_athletes: 8,
      medium: 0,
      medium_athletes: 0,
      low: 0,
      low_athletes: 0,
      status_new: 14,
      status_new_athletes: 9,
      status_acknowledged: 0,
      status_acknowledged_athletes: 0,
      status_escalated: 0,
      status_escalated_athletes: 0,
      status_resolved: 0,
      status_resolved_athletes: 0,
      status_dismissed: 0,
      status_dismissed_athletes: 0,
      ...overrides,
    };
  }

  // 'Critical: 1' plus the date a director was in the building names the
  // athlete it belongs to, however large the register is overall.
  test('withholds a board bucket drawn from fewer than five athletes', async () => {
    mockQueryOne.mockResolvedValueOnce(summaryRow());

    const summary = await getOrganizationViolationSummary('org-1', { audience: 'board' });

    expect(summary.severity.critical).toEqual({ status: 'insufficient_data', count: null });
    expect(summary.severity.high).toEqual({ status: 'available', count: 13 });
    expect(summary.total).toEqual({ status: 'available', count: 14 });
    expect(summary.minimumCohortSize).toBe(5);
  });

  test('reports an empty register as unavailable rather than a measured zero', async () => {
    mockQueryOne.mockResolvedValueOnce(summaryRow({
      total: 0,
      total_athletes: 0,
      critical: 0,
      critical_athletes: 0,
      high: 0,
      high_athletes: 0,
      status_new: 0,
      status_new_athletes: 0,
    }));

    const summary = await getOrganizationViolationSummary('org-1', { audience: 'board' });

    expect(summary.total).toEqual({ status: 'unavailable', count: null });
    expect(summary.severity.critical).toEqual({ status: 'unavailable', count: null });
    expect(summary.status.new).toEqual({ status: 'unavailable', count: null });
  });

  // The gym's own admin runs the program and needs the exact figure to act on.
  test('leaves an organization admin the exact counts', async () => {
    mockQueryOne.mockResolvedValueOnce(summaryRow());

    const summary = await getOrganizationViolationSummary('org-1', { audience: 'organization_admin' });

    expect(summary.severity.critical).toEqual({ status: 'insufficient_data', count: 1 });
    expect(summary.total).toEqual({ status: 'available', count: 14 });
  });

  test('sizes every cohort by aggregate alone and selects no athlete identifier', async () => {
    mockQueryOne.mockResolvedValueOnce(summaryRow());

    await getOrganizationViolationSummary('org-1', { audience: 'board' });

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['org-1']);
    expect(sql).toContain("count(distinct athlete_id) filter (where severity = 'critical')");
    expect(sql).toContain("count(distinct athlete_id) filter (where status = 'escalated')");
    const preceding = (sql as string).split('athlete_id').slice(0, -1);
    expect(preceding.every((chunk) => chunk.endsWith('count(distinct '))).toBe(true);
  });

  test('binds the status filter rather than interpolating it', async () => {
    mockQueryOne.mockResolvedValueOnce(summaryRow());

    await getOrganizationViolationSummary('org-1', { audience: 'board', status: 'escalated' });

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('and status = $2');
    expect(params).toEqual(['org-1', 'escalated']);
  });

  test('refuses to invent a summary when the aggregate query returns nothing', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(getOrganizationViolationSummary('org-1', { audience: 'board' }))
      .rejects.toThrow('COMPLIANCE_SUMMARY_UNAVAILABLE');
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
