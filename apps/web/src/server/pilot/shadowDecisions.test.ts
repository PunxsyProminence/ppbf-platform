jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowMedicalStatus', () => ({
  getLatestMedicalAdministrativeStatus: jest.fn(),
}));
jest.mock('./shadowRecommendations', () => ({
  assertMedicalStatusAllowsRecommendation: jest.fn(),
  MedicalStatusBlockedError: class MedicalStatusBlockedError extends Error {},
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { query, queryOne, withTransaction } from './db';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { assertMedicalStatusAllowsRecommendation, MedicalStatusBlockedError } from './shadowRecommendations';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import { getDecisionAthleteId, listDecisions, recordDecision, RecommendationNotActionableError } from './shadowDecisions';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);
const mockGetMedicalStatus = jest.mocked(getLatestMedicalAdministrativeStatus);
const mockAssertMedicalStatusAllows = jest.mocked(assertMedicalStatusAllowsRecommendation);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    decision_id: 'dec-1',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    recommendation_id: null,
    decision_text: 'Reduce sparring rounds this week.',
    expected_outcome: 'Contact exposure ratio trends back under 1.5 within 7 days.',
    decided_by_account_id: 'coach-1',
    decided_by_role: 'coach',
    medical_status_snapshot_id: null,
    status: 'active',
    decided_at: '2026-07-28T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
  mockGetMedicalStatus.mockResolvedValue(null);
});

describe('recordDecision', () => {
  // Replaces a test asserting the guard ran ONLY when isMedicallySensitive was
  // set. That flag came off the HTTP body, so the assertion pinned the hole:
  // omit the field, skip the clearance check.
  test('checks the medical status guard on every decision, whatever the topic', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [decisionRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await recordDecision({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      decisionText: 'Reduce sparring rounds this week.',
      expectedOutcome: 'Contact exposure ratio trends back under 1.5 within 7 days.',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    });

    expect(mockAssertMedicalStatusAllows).toHaveBeenCalledWith('org-1', 'athlete-1');
  });

  // The guard runs before the transaction opens, so a blocked athlete leaves no
  // partial write behind -- true for an ordinary decision, not only a
  // medically-worded one.
  test('an ordinary decision is blocked, and written, only per the clearance record', async () => {
    mockAssertMedicalStatusAllows.mockRejectedValueOnce(new MedicalStatusBlockedError('no_record'));

    await expect(recordDecision({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      decisionText: 'Add 10 minutes of footwork drills.',
      expectedOutcome: 'Work-rate consistency improves next session.',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    })).rejects.toBeInstanceOf(MedicalStatusBlockedError);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('propagates MedicalStatusBlockedError before any write when medically sensitive and blocked', async () => {
    mockAssertMedicalStatusAllows.mockRejectedValueOnce(new MedicalStatusBlockedError('restricted'));

    await expect(recordDecision({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      decisionText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    })).rejects.toBeInstanceOf(MedicalStatusBlockedError);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('throws RecommendationNotActionableError when the referenced recommendation is not provisional or accepted', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ status: 'expired' }] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await expect(recordDecision({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationId: 'rec-1',
      decisionText: 'Act on the expired recommendation.',
      expectedOutcome: 'Should not happen.',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    })).rejects.toBeInstanceOf(RecommendationNotActionableError);
  });

  test('allows recording a decision against a still-provisional recommendation', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'provisional' }] })
      .mockResolvedValueOnce({ rows: [decisionRow({ recommendation_id: 'rec-1' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await recordDecision({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationId: 'rec-1',
      decisionText: 'Reduce sparring rounds this week.',
      expectedOutcome: 'Contact exposure ratio trends back under 1.5 within 7 days.',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    });

    expect(result.recommendation_id).toBe('rec-1');
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
  });
});

describe('getDecisionAthleteId', () => {
  test('resolves the athlete a decision belongs to for cross-route access checks', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'athlete-1' });

    const result = await getDecisionAthleteId('org-1', 'dec-1');

    expect(result).toBe('athlete-1');
  });

  test('returns null when the decision does not exist', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getDecisionAthleteId('org-1', 'missing-decision');

    expect(result).toBeNull();
  });
});

describe('listDecisions', () => {
  test('scopes to the given organization and athlete, newest first', async () => {
    mockQuery.mockResolvedValueOnce([decisionRow()]);

    const results = await listDecisions('org-1', 'athlete-1');

    expect(results).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('order by decided_at desc');
    expect(params).toEqual(['org-1', 'athlete-1']);
  });
});
