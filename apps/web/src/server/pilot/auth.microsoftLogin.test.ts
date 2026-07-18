import { loginWithMicrosoftEmail } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/db', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
}));

import { query, queryOne } from '@/src/server/pilot/db';

describe('loginWithMicrosoftEmail', () => {
  const mockQuery = query as jest.MockedFunction<typeof query>;
  const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

  beforeEach(() => {
    mockQuery.mockReset();
    mockQueryOne.mockReset();
  });

  test('denies unknown Microsoft email', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await loginWithMicrosoftEmail('unknown@example.com');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('allows known active Microsoft account and issues session token', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'admin@punxsyprominence.org',
      role: 'platform_owner',
      organization_id: 'ppbf-default-org',
      is_platform_owner: true,
      athlete_id: null,
      active_flag: true,
      organization_status: 'active',
    });
    mockQuery.mockResolvedValueOnce(undefined as never);

    const result = await loginWithMicrosoftEmail('Admin@punxsyprominence.org');

    expect(result).not.toBeNull();
    expect(result?.principal.accountId).toBe('admin@punxsyprominence.org');
    expect(result?.principal.role).toBe('platform_owner');
    expect(result?.principal.organizationId).toBe('ppbf-default-org');
    expect(result?.token).toBeTruthy();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
