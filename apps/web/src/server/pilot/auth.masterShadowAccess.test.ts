jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { setAccountMasterShadowAccess } from './auth';
import { queryOne } from './db';

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('setAccountMasterShadowAccess', () => {
  test('grants the flag and returns the updated row', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'staff-1',
      role: 'staff',
      organization_id: 'org-1',
      has_master_shadow_access: true,
    });

    const result = await setAccountMasterShadowAccess('staff-1', true);

    expect(result).toEqual({
      accountId: 'staff-1',
      role: 'staff',
      organizationId: 'org-1',
      hasMasterShadowAccess: true,
    });

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('update pilot.accounts');
    expect(sql).toContain('has_master_shadow_access');
    expect(sql).toContain("role not in ('athlete', 'parent')");
    expect(params).toEqual(['staff-1', true]);
  });

  test('revokes the flag', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'staff-1',
      role: 'staff',
      organization_id: 'org-1',
      has_master_shadow_access: false,
    });

    const result = await setAccountMasterShadowAccess('staff-1', false);

    expect(result.hasMasterShadowAccess).toBe(false);
    const [, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['staff-1', false]);
  });

  test('throws when the account does not exist', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(setAccountMasterShadowAccess('missing', true)).rejects.toThrow('Not found');
  });

  // The WHERE clause itself excludes athlete/parent rows, so a targeted athlete
  // or parent account_id matches zero rows and falls into the same "not found"
  // path as a nonexistent account -- deliberately not a different, more
  // informative message, so the response cannot be used to fingerprint which
  // account_ids exist versus which exist but are ineligible.
  test('refuses an athlete or parent target by matching no rows', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(setAccountMasterShadowAccess('athlete-1', true)).rejects.toThrow(
      'Not found: no such account, or its role cannot hold cross-organization access',
    );
  });
});
