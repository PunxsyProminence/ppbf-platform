jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowRecommendations', () => ({
  readMedicalStatusOnFile: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { query, queryOne, withTransaction } from './db';
import { readMedicalStatusOnFile, type MedicalStatusOnFile } from './shadowRecommendations';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import { getDecisionAthleteId, listDecisions, recordDecision, RecommendationNotActionableError } from './shadowDecisions';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);
const mockOnFile = jest.mocked(readMedicalStatusOnFile);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);

const NONE_ON_FILE: MedicalStatusOnFile = { medicalStatusOnFile: 'no_record', medicalStatusId: null, medicalStatusExpiresAt: null };

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

const DECISION = {
  organizationId: 'org-1',
  athleteId: 'athlete-1',
  decisionText: 'Easy skipping only today; recheck next session.',
  expectedOutcome: 'Calf tightness settles by next session.',
  decidedByAccountId: 'coach-1',
  decidedByRole: 'coach',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
  mockOnFile.mockResolvedValue(NONE_ON_FILE);
});

// Jason, 2026-10-10 and -11 (OD-2026-10-10-004 to -007): the coach makes the
// assessment; the app records. Issue #1474: a decision is never refused for
// the athlete's medical status, and the status on file is stored with it.
describe('recordDecision records whatever the medical status on file says', () => {
  test.each<[string, MedicalStatusOnFile]>([
    ['none on file', NONE_ON_FILE],
    ['pending', { medicalStatusOnFile: 'pending', medicalStatusId: 'status-p', medicalStatusExpiresAt: null }],
    ['not cleared', { medicalStatusOnFile: 'not_cleared', medicalStatusId: 'status-n', medicalStatusExpiresAt: null }],
    ['restricted', { medicalStatusOnFile: 'restricted', medicalStatusId: 'status-r', medicalStatusExpiresAt: null }],
    ['a lapsed clearance', { medicalStatusOnFile: 'cleared_expired', medicalStatusId: 'status-e', medicalStatusExpiresAt: '2026-10-01 16:00:00+00' }],
    ['cleared', { medicalStatusOnFile: 'cleared', medicalStatusId: 'status-c', medicalStatusExpiresAt: null }],
  ])('%s: the decision is written, with the status row on it and the status in its audit entry', async (_label, onFile) => {
    mockOnFile.mockResolvedValue(onFile);
    const clientQuery = jest.fn().mockResolvedValue({ rows: [decisionRow({ medical_status_snapshot_id: onFile.medicalStatusId })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await expect(recordDecision(DECISION)).resolves.toMatchObject({ decision_id: 'dec-1' });

    expect(mockOnFile).toHaveBeenCalledWith('org-1', 'athlete-1');
    const [, params] = clientQuery.mock.calls[0];
    expect((params as unknown[])[7]).toBe(onFile.medicalStatusId);
    expect(mockWriteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'recorded',
      afterState: expect.objectContaining(onFile),
    }));
  });

  test('throws RecommendationNotActionableError when the referenced recommendation is not provisional or accepted', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ status: 'expired' }] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await expect(recordDecision({ ...DECISION, recommendationId: 'rec-1' })).rejects.toBeInstanceOf(RecommendationNotActionableError);
  });

  test('allows recording a decision against a still-provisional recommendation', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'provisional' }] })
      .mockResolvedValueOnce({ rows: [decisionRow({ recommendation_id: 'rec-1' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await recordDecision({ ...DECISION, recommendationId: 'rec-1' });

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
  test('scopes to the given organization and athlete, newest first, reading the status row in the same gym', async () => {
    mockQuery.mockResolvedValueOnce([{ ...decisionRow(), snapshot_status: null, snapshot_expires_at: null }]);

    const results = await listDecisions('org-1', 'athlete-1');

    expect(results).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('order by d.decided_at desc');
    expect(String(sql)).toContain('s.organization_id = d.organization_id and s.athlete_id = d.athlete_id');
    expect(params).toEqual(['org-1', 'athlete-1']);
  });

  test('each decision carries the status that was on file when it was recorded, as of that moment', async () => {
    mockQuery.mockResolvedValueOnce([
      { ...decisionRow({ decision_id: 'none' }), snapshot_status: null, snapshot_expires_at: null },
      { ...decisionRow({ decision_id: 'pending', medical_status_snapshot_id: 's-p' }), snapshot_status: 'pending', snapshot_expires_at: null },
      // Cleared until Oct 1; decided Sep 1: it was cleared then, whatever today says.
      {
        ...decisionRow({ decision_id: 'cleared-then', medical_status_snapshot_id: 's-c', decided_at: '2026-09-01T10:00:00.000Z' }),
        snapshot_status: 'cleared',
        snapshot_expires_at: '2026-10-01 16:00:00+00',
      },
      // The same clearance, decided after it ran out.
      {
        ...decisionRow({ decision_id: 'lapsed-then', medical_status_snapshot_id: 's-c', decided_at: '2026-10-05T10:00:00.000Z' }),
        snapshot_status: 'cleared',
        snapshot_expires_at: '2026-10-01 16:00:00+00',
      },
    ]);

    const results = await listDecisions('org-1', 'athlete-1');

    expect(results.map((row) => [row.decision_id, row.medical_status_on_file, row.medical_status_expires_at])).toEqual([
      ['none', 'no_record', null],
      ['pending', 'pending', null],
      ['cleared-then', 'cleared', '2026-10-01 16:00:00+00'],
      ['lapsed-then', 'cleared_expired', '2026-10-01 16:00:00+00'],
    ]);
    expect(results[0]).not.toHaveProperty('snapshot_status');
  });
});
