jest.mock('./db', () => ({
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowAuditEntries', () => ({
  writeShadowAuditEntry: jest.fn(),
}));

import { queryOne, withTransaction } from './db';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import { getLatestMedicalAdministrativeStatus, setMedicalAdministrativeStatus } from './shadowMedicalStatus';

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
    created_at: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

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
});
