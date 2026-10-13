jest.mock('./db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
// Only the database read is mocked. isClearanceCurrent / effectiveMedicalStatus
// are pure functions and are the shared rule this guard is being tested for --
// stubbing them out would test the mock instead of the time bound.
jest.mock('./shadowMedicalStatus', () => {
  const actual = jest.requireActual('./shadowMedicalStatus');
  return { ...actual, getLatestMedicalAdministrativeStatus: jest.fn() };
});
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { query, withTransaction } from './db';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import type { ShadowMedicalAdministrativeStatusRow } from './shadowMedicalStatus';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import {
  createProvisionalRecommendation,
  decideOnRecommendation,
  listRecommendations,
  readMedicalStatusOnFile,
} from './shadowRecommendations';

const mockQuery = jest.mocked(query);
const mockWithTransaction = jest.mocked(withTransaction);
const mockGetMedicalStatus = jest.mocked(getLatestMedicalAdministrativeStatus);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);

function recommendationRow(overrides: Record<string, unknown> = {}) {
  return {
    recommendation_id: 'rec-1',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    source_formula_result_id: null,
    recommendation_text: 'Reduce sparring rounds this week.',
    expected_outcome: 'Contact exposure ratio trends back under 1.5 within 7 days.',
    status: 'provisional',
    created_by_account_id: 'coach-1',
    created_at: '2026-07-28T10:00:00.000Z',
    expires_at: '2026-07-31T10:00:00.000Z',
    decided_by_account_id: null,
    decided_at: null,
    ...overrides,
  };
}

/** An explicitly cleared status; overrides make the other states. */
function clearedStatus(
  overrides: Partial<ShadowMedicalAdministrativeStatusRow> = {},
): ShadowMedicalAdministrativeStatusRow {
  return {
    status_id: 'status-cleared',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    status: 'cleared',
    restriction_flags: {},
    source_reference: 'physician-note-123',
    set_by_account_id: 'coach-1',
    set_by_role: 'coach',
    effective_at: '2026-07-27T10:00:00.000Z',
    // Null = no stated expiry, which is the default posture: see the
    // TODO(owner) on ShadowMedicalAdministrativeStatusRow.expires_at.
    expires_at: null,
    created_at: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
});

describe('createProvisionalRecommendation', () => {
  test('always creates the row with the literal status "provisional"', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce(clearedStatus());
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Reduce sparring rounds this week.',
      expectedOutcome: 'Contact exposure ratio trends back under 1.5 within 7 days.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
    });

    expect(clientQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = clientQuery.mock.calls[0];
    expect(String(sql)).toContain("'provisional'");
    // 'provisional' must be a literal in the SQL, never a bound parameter --
    // confirm no caller-controlled value in the params list equals it.
    expect(params).not.toContain('provisional');
  });

  // Issue #1474 (Jason, OD-2026-10-10-004 to -007: the coach makes the
  // assessment; the app records). Creating a recommendation is never refused
  // for the athlete's medical status; the status on file goes into the audit.
  test.each<[string, ShadowMedicalAdministrativeStatusRow | null, string]>([
    ['no status on file', null, 'no_record'],
    ['pending', clearedStatus({ status_id: 'status-p', status: 'pending' }), 'pending'],
    ['restricted', clearedStatus({ status_id: 'status-r', status: 'restricted' }), 'restricted'],
    ['not cleared', clearedStatus({ status_id: 'status-n', status: 'not_cleared' }), 'not_cleared'],
    ['a lapsed clearance', clearedStatus({ status_id: 'status-e', expires_at: '2026-01-01T00:00:00.000Z' }), 'cleared_expired'],
    ['cleared', clearedStatus(), 'cleared'],
  ])('%s: the recommendation is created and its audit entry carries the status on file', async (_label, row, word) => {
    mockGetMedicalStatus.mockResolvedValueOnce(row);
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
    })).resolves.toBeDefined();

    expect(mockGetMedicalStatus).toHaveBeenCalledWith('org-1', 'athlete-1');
    expect(mockWriteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'created_provisional',
      afterState: expect.objectContaining({
        status: 'provisional',
        medicalStatusOnFile: word,
        medicalStatusId: row?.status_id ?? null,
        medicalStatusExpiresAt: row?.expires_at ?? null,
      }),
    }));
  });
});

describe('readMedicalStatusOnFile', () => {
  test('states the status as of the moment given, so a clearance reads as it stood then', async () => {
    mockGetMedicalStatus.mockResolvedValue(clearedStatus({ expires_at: '2026-10-01T16:00:00.000Z' }));

    await expect(readMedicalStatusOnFile('org-1', 'athlete-1', new Date('2026-09-01T00:00:00.000Z'))).resolves.toEqual({
      medicalStatusOnFile: 'cleared',
      medicalStatusId: 'status-cleared',
      medicalStatusExpiresAt: '2026-10-01T16:00:00.000Z',
    });
    await expect(readMedicalStatusOnFile('org-1', 'athlete-1', new Date('2026-10-05T00:00:00.000Z'))).resolves.toMatchObject({
      medicalStatusOnFile: 'cleared_expired',
    });
  });
});

describe('decideOnRecommendation', () => {
  // Issue #1474: deciding is never refused for the medical status; the status
  // on file goes into the decision's audit entry.
  test('a decision on a recommendation for an athlete with no status on file is recorded with that fact', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce(null);
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow({ status: 'rejected', decided_by_account_id: 'coach-1' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await expect(decideOnRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationId: 'rec-1',
      decision: 'rejected',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    })).resolves.toMatchObject({ status: 'rejected' });

    expect(mockWriteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'decided_rejected',
      afterState: { status: 'rejected', medicalStatusOnFile: 'no_record', medicalStatusId: null, medicalStatusExpiresAt: null },
    }));
  });

  test('only transitions a recommendation that is currently provisional', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow({ status: 'accepted', decided_by_account_id: 'coach-1' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await decideOnRecommendation({
      organizationId: 'org-1',
      // Fixture repair, not a change of intent: decideOnRecommendation now
      // requires the owner its caller authorized, and binds it into the
      // UPDATE. 'athlete-1' is recommendationRow's own athlete_id, so this
      // call still describes the same legitimate decision it always did.
      athleteId: 'athlete-1',
      recommendationId: 'rec-1',
      decision: 'accepted',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    });

    const [sql] = clientQuery.mock.calls[0];
    expect(String(sql)).toContain("status = 'provisional'");
  });

  test('binds the caller-authorized athlete into the WHERE, so the row written is the row authorized', async () => {
    // The route above this resolves the recommendation's stored owner and
    // authorizes it. That is only load-bearing if the owner then reaches the
    // statement: without `athlete_id` in the predicate, the UPDATE matches on
    // (organization_id, recommendation_id) alone and the athlete that was
    // checked and the row that was written are free to be different children.
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow({ status: 'accepted' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await decideOnRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationId: 'rec-1',
      decision: 'accepted',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    });

    const [sql, params] = clientQuery.mock.calls[0];
    expect(String(sql)).toMatch(/where[\s\S]*athlete_id = \$5/);
    expect(params).toContain('athlete-1');
  });

  test('returns null instead of throwing when the recommendation is no longer provisional', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await decideOnRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationId: 'rec-1',
      decision: 'accepted',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    });

    expect(result).toBeNull();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });
});

describe('listRecommendations', () => {
  test('lazily expires stale provisional rows before listing', async () => {
    mockQuery
      .mockResolvedValueOnce([]) // the expiry UPDATE
      .mockResolvedValueOnce([recommendationRow({ status: 'expired' })]); // the SELECT

    const results = await listRecommendations({ organizationId: 'org-1', athleteId: 'athlete-1' });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(String(mockQuery.mock.calls[0][0])).toContain("set status = 'expired'");
    expect(String(mockQuery.mock.calls[0][0])).toContain('expires_at < now()');
    expect(results[0].status).toBe('expired');
  });
});
