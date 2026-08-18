jest.mock('./db', () => ({
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { queryOne, withTransaction } from './db';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import {
  EXPIRED_CLEARANCE_STATUS,
  effectiveMedicalStatus,
  getLatestMedicalAdministrativeStatus,
  isClearanceCurrent,
  setMedicalAdministrativeStatus,
  type ShadowMedicalAdministrativeStatusRow,
} from './shadowMedicalStatus';

const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);
const mockWriteAudit = jest.mocked(writeShadowAuditEntry);

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    status_id: 'status-1',
    organization_id: 'org-1',
    athlete_id: 'athlete-1',
    status: 'cleared',
    restriction_flags: {},
    source_reference: null,
    set_by_account_id: 'coach-1',
    set_by_role: 'coach',
    effective_at: '2026-07-27T10:00:00.000Z',
    expires_at: null,
    created_at: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

function clearedRow(overrides: Record<string, unknown> = {}): ShadowMedicalAdministrativeStatusRow {
  return statusRow(overrides) as ShadowMedicalAdministrativeStatusRow;
}

const NOW = new Date('2026-08-18T12:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAudit.mockResolvedValue(undefined);
});

describe('setMedicalAdministrativeStatus', () => {
  test('inserts a new row and writes an audit entry in the same transaction', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [statusRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    const result = await setMedicalAdministrativeStatus({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      status: 'cleared',
      setByAccountId: 'coach-1',
      setByRole: 'coach',
    });

    expect(result.status).toBe('cleared');
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const [, auditInput] = mockWriteAudit.mock.calls[0];
    expect(auditInput.entityType).toBe('medical_status');
    expect(auditInput.actorAccountId).toBe('coach-1');
  });

  test('never mutates an existing row -- each call always inserts a fresh record', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [statusRow({ status: 'restricted' })] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await setMedicalAdministrativeStatus({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      status: 'restricted',
      setByAccountId: 'coach-1',
      setByRole: 'coach',
    });

    const [sql] = clientQuery.mock.calls[0];
    expect(String(sql)).toContain('insert into pilot.shadow_medical_administrative_status');
    expect(String(sql)).not.toContain('update');
  });
});

describe('getLatestMedicalAdministrativeStatus', () => {
  test('returns the most recent status row ordered by effective_at desc', async () => {
    mockQueryOne.mockResolvedValueOnce(statusRow({ status: 'not_cleared' }));

    const result = await getLatestMedicalAdministrativeStatus('org-1', 'athlete-1');

    expect(result?.status).toBe('not_cleared');
    const [sql] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('order by effective_at desc');
    expect(String(sql)).toContain('limit 1');
  });

  test('returns null when no status has ever been recorded', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getLatestMedicalAdministrativeStatus('org-1', 'athlete-1');

    expect(result).toBeNull();
  });

  test('selects the expiry, so a reader can apply the time bound at all', async () => {
    mockQueryOne.mockResolvedValueOnce(statusRow({ expires_at: '2026-09-01T00:00:00.000Z' }));

    const result = await getLatestMedicalAdministrativeStatus('org-1', 'athlete-1');

    expect(result?.expires_at).toBe('2026-09-01T00:00:00.000Z');
    const [sql] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('expires_at');
  });
});

describe('the expiry a clearance is read against', () => {
  // The finding this closes: the gates compared `status === 'cleared'` on the
  // latest row with no time bound at all, so one clearance recorded once stayed
  // valid forever. These tests pin the time bound itself, not a duration --
  // this codebase has no confirmed clinical validity window and deliberately
  // does not invent one (see the TODO(owner) on expires_at).
  test('a cleared record with no stated expiry is current -- unchanged from before expiry existed', () => {
    expect(isClearanceCurrent(clearedRow({ expires_at: null }), NOW)).toBe(true);
    expect(effectiveMedicalStatus(clearedRow({ expires_at: null }), NOW)).toBe('cleared');
  });

  test('a cleared record whose expiry is still ahead is current', () => {
    const row = clearedRow({ expires_at: '2026-09-01T00:00:00.000Z' });
    expect(isClearanceCurrent(row, NOW)).toBe(true);
    expect(effectiveMedicalStatus(row, NOW)).toBe('cleared');
  });

  test('a cleared record past its expiry is NOT current and reports as expired', () => {
    const row = clearedRow({ expires_at: '2026-08-01T00:00:00.000Z' });
    expect(isClearanceCurrent(row, NOW)).toBe(false);
    expect(effectiveMedicalStatus(row, NOW)).toBe(EXPIRED_CLEARANCE_STATUS);
  });

  test('the expiry instant itself is already past -- the boundary is exclusive', () => {
    const row = clearedRow({ expires_at: NOW.toISOString() });
    expect(isClearanceCurrent(row, NOW)).toBe(false);
  });

  test('an unparseable expiry reads as expired, never as "no expiry"', () => {
    // A corrupt time bound must not silently become permission. Fail closed.
    expect(isClearanceCurrent(clearedRow({ expires_at: 'not-a-timestamp' }), NOW)).toBe(false);
    expect(effectiveMedicalStatus(clearedRow({ expires_at: 'not-a-timestamp' }), NOW))
      .toBe(EXPIRED_CLEARANCE_STATUS);
  });

  test('no record at all is not a clearance, and reports as no_record', () => {
    expect(isClearanceCurrent(null, NOW)).toBe(false);
    expect(effectiveMedicalStatus(null, NOW)).toBe('no_record');
  });

  test.each(['restricted', 'not_cleared', 'pending'])(
    'a %s record is never current, whatever its expiry says',
    (status) => {
      expect(isClearanceCurrent(clearedRow({ status, expires_at: null }), NOW)).toBe(false);
      expect(isClearanceCurrent(clearedRow({ status, expires_at: '2026-09-01T00:00:00.000Z' }), NOW)).toBe(false);
    },
  );

  // Deliberate asymmetry, and the direction matters: only a CLEARANCE is
  // downgraded by expiry. A lapsed restriction must keep restricting until a
  // human records something new, because a restriction that expires itself into
  // permission is the exact failure this module exists to prevent.
  test('an expired restriction still reports as restricted, not as expired or cleared', () => {
    const row = clearedRow({ status: 'restricted', expires_at: '2026-08-01T00:00:00.000Z' });
    expect(effectiveMedicalStatus(row, NOW)).toBe('restricted');
  });
});

describe('the expiry a clearance is written with', () => {
  test('an explicit expiry is stored, and lands in the audit entry', async () => {
    const clientQuery = jest.fn().mockResolvedValue({
      rows: [statusRow({ expires_at: '2026-09-01T00:00:00.000Z' })],
    });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await setMedicalAdministrativeStatus({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      status: 'cleared',
      expiresAt: '2026-09-01T00:00:00.000Z',
      setByAccountId: 'coach-1',
      setByRole: 'coach',
    });

    const [sql, params] = clientQuery.mock.calls[0];
    expect(String(sql)).toContain('expires_at');
    expect(params).toContain('2026-09-01T00:00:00.000Z');

    // "cleared until September" and "cleared indefinitely" are different
    // decisions by the same person, so the audit trail must tell them apart.
    const [, auditInput] = mockWriteAudit.mock.calls[0];
    expect(auditInput.afterState).toMatchObject({ expiresAt: '2026-09-01T00:00:00.000Z' });
  });

  test('an omitted expiry is stored as null, not as an invented interval', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [statusRow()] });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));

    await setMedicalAdministrativeStatus({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      status: 'cleared',
      setByAccountId: 'coach-1',
      setByRole: 'coach',
    });

    const [, params] = clientQuery.mock.calls[0];
    expect(params[params.length - 1]).toBeNull();
  });
});
