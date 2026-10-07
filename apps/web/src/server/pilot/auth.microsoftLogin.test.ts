import { loginWithMicrosoftEmail } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/db', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
}));

import { query, queryOne } from '@/src/server/pilot/db';

describe('loginWithMicrosoftEmail', () => {
  const mockQuery = query as jest.MockedFunction<typeof query>;
  const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
  const originalPrimaryOwnerEmail = process.env.PPBF_PRIMARY_OWNER_EMAIL;

  beforeEach(() => {
    mockQuery.mockReset();
    mockQueryOne.mockReset();
    process.env.PPBF_PRIMARY_OWNER_EMAIL = 'admin@punxsyprominence.org';
  });

  afterAll(() => {
    if (originalPrimaryOwnerEmail === undefined) {
      delete process.env.PPBF_PRIMARY_OWNER_EMAIL;
    } else {
      process.env.PPBF_PRIMARY_OWNER_EMAIL = originalPrimaryOwnerEmail;
    }
  });

  function accountRow(overrides: Record<string, unknown> = {}) {
    return {
      account_id: 'admin@punxsyprominence.org',
      role: 'platform_owner',
      organization_id: 'ppbf-default-org',
      is_platform_owner: true,
      athlete_id: null,
      active_flag: true,
      account_deleted: false,
      organization_status: 'active',
      ...overrides,
    };
  }

  test('denies unknown Microsoft email', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await loginWithMicrosoftEmail('unknown@example.com');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('allows known active Microsoft account and issues session token', async () => {
    mockQueryOne.mockResolvedValueOnce(accountRow());
    mockQuery.mockResolvedValueOnce(undefined as never);

    const result = await loginWithMicrosoftEmail('Admin@punxsyprominence.org');

    expect(result).not.toBeNull();
    expect(result?.principal.accountId).toBe('admin@punxsyprominence.org');
    expect(result?.principal.role).toBe('platform_owner');
    expect(result?.principal.organizationId).toBe('ppbf-default-org');
    expect(result?.token).toBeTruthy();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('issues a session for an invited volunteer', async () => {
    mockQueryOne.mockResolvedValueOnce(accountRow({
      account_id: 'vol@example.com',
      role: 'volunteer',
      organization_id: 'org-1',
      is_platform_owner: false,
    }));
    mockQuery.mockResolvedValueOnce(undefined as never);

    const result = await loginWithMicrosoftEmail('vol@example.com');

    expect(result?.principal.role).toBe('volunteer');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Sign-in refuses any account marked deleted (OD-2026-09-29-003 Q9), even
  // one an admin path has set active again.
  test('refuses an account marked deleted, though active, without writing a session row', async () => {
    mockQueryOne.mockResolvedValueOnce(accountRow({
      account_id: 'coach@example.com',
      role: 'coach',
      organization_id: 'org-1',
      is_platform_owner: false,
      account_deleted: true,
    }));

    const result = await loginWithMicrosoftEmail('coach@example.com');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Fail closed: a row that does not say it is not deleted admits nobody.
  test('refuses a row with no deletion flag at all', async () => {
    const row: Record<string, unknown> = accountRow({
      account_id: 'coach@example.com',
      role: 'coach',
      organization_id: 'org-1',
      is_platform_owner: false,
    });
    delete row.account_deleted;
    mockQueryOne.mockResolvedValueOnce(row);

    const result = await loginWithMicrosoftEmail('coach@example.com');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Every refusal below used to run after the insert, so a sign-in that was
  // turned away still left a live pilot.session_tokens row behind.
  test('refuses a role with no workspace without writing a session row', async () => {
    mockQueryOne.mockResolvedValueOnce(accountRow({
      account_id: 'future@example.com',
      role: 'future_privileged_role',
      organization_id: 'org-1',
      is_platform_owner: false,
    }));

    await expect(loginWithMicrosoftEmail('future@example.com'))
      .rejects.toThrow('Forbidden: unsupported authenticated role');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses a platform owner row on a different identity without writing a session row', async () => {
    mockQueryOne.mockResolvedValueOnce(accountRow({ account_id: 'impostor@example.com' }));

    await expect(loginWithMicrosoftEmail('impostor@example.com'))
      .rejects.toThrow('Forbidden: platform owner identity mismatch');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // CL-A19: the stored oid + tid decide; the email only finds the account.
  describe('directory identity binding', () => {
    const identity = { objectId: 'oid-1', tenantId: 'tenant-1' };
    const coach = { account_id: 'coach@example.com', role: 'coach', organization_id: 'org-1', is_platform_owner: false };

    test('a bound account presenting its own pair is admitted without a binding write', async () => {
      mockQueryOne.mockResolvedValueOnce(accountRow({ ...coach, microsoft_oid: 'oid-1', microsoft_tid: 'tenant-1' }));
      mockQuery.mockResolvedValueOnce(undefined as never);

      const result = await loginWithMicrosoftEmail('coach@example.com', identity);

      expect(result?.principal.accountId).toBe('coach@example.com');
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['a different oid', { objectId: 'oid-2', tenantId: 'tenant-1' }],
      ['a different tenant', { objectId: 'oid-1', tenantId: 'tenant-2' }],
    ])('a bound account presenting %s is refused without writing a session row', async (_label, presented) => {
      mockQueryOne.mockResolvedValueOnce(accountRow({ ...coach, microsoft_oid: 'oid-1', microsoft_tid: 'tenant-1' }));

      await expect(loginWithMicrosoftEmail('coach@example.com', presented))
        .rejects.toThrow('Forbidden: Microsoft identity mismatch');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('an unbound account is bound to the pair it presented, then admitted', async () => {
      mockQueryOne
        .mockResolvedValueOnce(accountRow({ ...coach, microsoft_oid: null, microsoft_tid: null }))
        .mockResolvedValueOnce({ microsoft_oid: 'oid-1', microsoft_tid: 'tenant-1' });
      mockQuery.mockResolvedValueOnce(undefined as never);

      const result = await loginWithMicrosoftEmail('coach@example.com', identity);

      expect(result?.principal.accountId).toBe('coach@example.com');
      expect(mockQueryOne.mock.calls[1][0]).toMatch(/update pilot\.accounts[\s\S]*microsoft_oid is null/);
      expect(mockQueryOne.mock.calls[1][1]).toEqual(['coach@example.com', 'oid-1', 'tenant-1']);
    });

    test('a pair already bound to another account is refused without writing a session row', async () => {
      mockQueryOne
        .mockResolvedValueOnce(accountRow({ ...coach, microsoft_oid: null, microsoft_tid: null }))
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(loginWithMicrosoftEmail('coach@example.com', identity))
        .rejects.toThrow('Forbidden: Microsoft identity already bound to another account');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('a refused account is never bound', async () => {
      mockQueryOne.mockResolvedValueOnce(accountRow({ ...coach, active_flag: false, microsoft_oid: null, microsoft_tid: null }));

      expect(await loginWithMicrosoftEmail('coach@example.com', identity)).toBeNull();
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
    });
  });
});
