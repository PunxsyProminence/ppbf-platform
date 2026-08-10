jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { getGuardianGateSummary } from './safetyGateMatrix';
import { query } from './db';

const mockQuery = jest.mocked(query);

afterEach(() => {
  jest.clearAllMocks();
});

describe('getGuardianGateSummary', () => {
  test('never exposes reason or metadata -- only gate identity and outcome', async () => {
    mockQuery.mockResolvedValueOnce([
      { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00.000Z' },
    ]);

    const result = await getGuardianGateSummary('org-1', 'ath-1');

    expect(result).toEqual([
      { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00.000Z' },
    ]);
    // The row shape returned by the SQL never carried a reason/metadata key
    // in the first place -- assert the query itself doesn't select them,
    // so a future edit can't silently widen what leaves this function.
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).not.toContain('reason');
    expect(String(sql)).not.toContain('metadata');
  });

  test('a gate never evaluated for this athlete reads as not_evaluated, not a missing row', async () => {
    mockQuery.mockResolvedValueOnce([
      { gate_key: 'training_hold', name: 'Active Training Hold', category: 'training_level', outcome: null, evaluated_at: null },
    ]);

    const result = await getGuardianGateSummary('org-1', 'ath-1');

    expect(result).toEqual([
      { gate_key: 'training_hold', name: 'Active Training Hold', category: 'training_level', outcome: 'not_evaluated', evaluated_at: null },
    ]);
  });

  test('only active gates are queried', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getGuardianGateSummary('org-1', 'ath-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('active_flag = true');
    expect(params).toEqual(['org-1', 'ath-1']);
  });

  test('no gates at all returns an empty array', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await expect(getGuardianGateSummary('org-1', 'ath-1')).resolves.toEqual([]);
  });
});
