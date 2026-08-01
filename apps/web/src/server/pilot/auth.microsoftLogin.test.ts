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
});
