jest.mock('./db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowMedicalStatus', () => ({
  getLatestMedicalAdministrativeStatus: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { query, withTransaction } from './db';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import {
  createProvisionalRecommendation,
  decideOnRecommendation,
  listRecommendations,
  MedicalStatusBlockedError,
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

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
});

describe('createProvisionalRecommendation', () => {
  test('always creates the row with the literal status "provisional"', async () => {
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

  test('blocks creation when the athlete is restricted/not-cleared and the topic is medically sensitive', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce({
      status_id: 'status-1',
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      status: 'restricted',
      restriction_flags: {},
      source_reference: null,
      set_by_account_id: 'coach-1',
      set_by_role: 'coach',
      effective_at: '2026-07-27T10:00:00.000Z',
      created_at: '2026-07-27T10:00:00.000Z',
    });

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
      isMedicallySensitive: true,
    })).rejects.toBeInstanceOf(MedicalStatusBlockedError);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('blocks a medically sensitive recommendation when no clearance record exists at all', async () => {
    // Fail closed: absence of a status is not a clearance decision. An
    // athlete with no medical administrative status on file must not sail
    // through a sparring/weight-cut/clearance recommendation by default.
    mockGetMedicalStatus.mockResolvedValueOnce(null);

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
      isMedicallySensitive: true,
    })).rejects.toBeInstanceOf(MedicalStatusBlockedError);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('blocks a medically sensitive recommendation while status is only pending', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce({
      status_id: 'status-2',
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      status: 'pending',
      restriction_flags: {},
      source_reference: null,
      set_by_account_id: 'coach-1',
      set_by_role: 'coach',
      effective_at: '2026-07-27T10:00:00.000Z',
      created_at: '2026-07-27T10:00:00.000Z',
    });

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
      isMedicallySensitive: true,
    })).rejects.toBeInstanceOf(MedicalStatusBlockedError);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('allows a medically sensitive recommendation only once status is explicitly cleared', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce({
      status_id: 'status-3',
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      status: 'cleared',
      restriction_flags: {},
      source_reference: 'physician-note-123',
      set_by_account_id: 'coach-1',
      set_by_role: 'coach',
      effective_at: '2026-07-27T10:00:00.000Z',
      created_at: '2026-07-27T10:00:00.000Z',
    });

    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow()] });
    mockWithTransaction.mockImplementationOnce(async (fn) => fn({ query: clientQuery } as never));

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
      isMedicallySensitive: true,
    })).resolves.toBeDefined();
  });

  test('does not consult medical status at all when the topic is not flagged sensitive', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Add 10 minutes of footwork drills.',
      expectedOutcome: 'Work-rate consistency improves next session.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
    });

    expect(mockGetMedicalStatus).not.toHaveBeenCalled();
  });
});

describe('decideOnRecommendation', () => {
  test('only transitions a recommendation that is currently provisional', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow({ status: 'accepted', decided_by_account_id: 'coach-1' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await decideOnRecommendation({
      organizationId: 'org-1',
      recommendationId: 'rec-1',
      decision: 'accepted',
      decidedByAccountId: 'coach-1',
      decidedByRole: 'coach',
    });

    const [sql] = clientQuery.mock.calls[0];
    expect(String(sql)).toContain("status = 'provisional'");
  });

  test('returns null instead of throwing when the recommendation is no longer provisional', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await decideOnRecommendation({
      organizationId: 'org-1',
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
