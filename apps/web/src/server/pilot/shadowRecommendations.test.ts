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

/**
 * An explicitly cleared status.
 *
 * Needed by every write test now, not only the medically-worded ones: the guard
 * is unconditional, so a test that does not stub a cleared record is asserting
 * the blocked path whether it meant to or not.
 */
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
    // Cleared record required to reach the write at all: the medical guard is
    // unconditional now, so an unstubbed status asserts the blocked path.
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
      expires_at: null,
      created_at: '2026-07-27T10:00:00.000Z',
    });

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
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
      expires_at: null,
      created_at: '2026-07-27T10:00:00.000Z',
    });

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
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
      expires_at: null,
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
    })).resolves.toBeDefined();
  });

  // Replaces a test that asserted the opposite -- that an unflagged topic did
  // not consult medical status at all. That was the hole: the caller decided
  // whether the gate ran, so omitting one JSON field skipped it.
  test('consults medical status even for an obviously non-medical recommendation', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce(clearedStatus());
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

    expect(mockGetMedicalStatus).toHaveBeenCalledWith('org-1', 'athlete-1');
  });

  // The time bound, stated as a test. Before expires_at existed this guard
  // compared `status !== 'cleared'` on the latest row with no clock involved,
  // so a clearance recorded once let every medically sensitive recommendation
  // through forever.
  test('blocks when the clearance on file has passed its stated expiry', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce(clearedStatus({
      expires_at: '2026-01-01T00:00:00.000Z',
    }));

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
    })).rejects.toThrow(/expiry/i);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('allows it while the clearance on file is still inside its expiry', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce(clearedStatus({
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    const clientQuery = jest.fn().mockResolvedValue({ rows: [recommendationRow()] });
    mockWithTransaction.mockImplementationOnce(async (fn) => fn({ query: clientQuery } as never));

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Clear athlete for full-contact sparring.',
      expectedOutcome: 'Athlete returns to full sparring load.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
    })).resolves.toBeDefined();
  });

  // The forgery path, stated as a test. There is no longer any input a caller
  // can supply, or omit, that skips the guard.
  test('a footwork note is blocked when the athlete has no clearance record', async () => {
    mockGetMedicalStatus.mockResolvedValueOnce(null);

    await expect(createProvisionalRecommendation({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      recommendationText: 'Add 10 minutes of footwork drills.',
      expectedOutcome: 'Work-rate consistency improves next session.',
      createdByAccountId: 'coach-1',
      createdByRole: 'coach',
    })).rejects.toBeInstanceOf(MedicalStatusBlockedError);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });
});

describe('decideOnRecommendation', () => {
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
