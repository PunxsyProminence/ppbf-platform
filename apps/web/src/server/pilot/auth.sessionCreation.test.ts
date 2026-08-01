jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(() => 'opaque-token'),
  hashToken: jest.fn(() => 'hashed-token'),
  hashPin: jest.fn(),
  verifyPin: jest.fn(async () => true),
}));

import { loginWithAccountIdAndPin, loginWithMicrosoftEmail } from './auth';
import { query, queryOne } from './db';
import { SESSION_ABSOLUTE_LIFETIME_MS } from './sessionPolicy';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('new sessions store expires_at', () => {
  test('loginWithAccountIdAndPin inserts a 24-hour expires_at for athlete local sessions', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'acct-1',
      role: 'athlete',
      organization_id: 'org-1',
      is_platform_owner: false,
      athlete_id: 'ath-1',
      auth_provider: 'ppbf_local',
      pin_hash: 'hash',
      active_flag: true,
      has_master_shadow_access: false,
      organization_status: 'active',
    });
    mockQuery.mockResolvedValueOnce([]);

    const before = Date.now();
    const result = await loginWithAccountIdAndPin('acct-1', '123456');
    const after = Date.now();

    expect(result).not.toBeNull();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.session_tokens');
    expect(sql).toContain('expires_at');
    const expiresAt = params[3] as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_ABSOLUTE_LIFETIME_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_ABSOLUTE_LIFETIME_MS);
  });

  test('loginWithAccountIdAndPin rejects non-athlete local accounts before writing a session', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'coach-1',
      role: 'coach',
      organization_id: 'org-1',
      is_platform_owner: false,
      athlete_id: null,
      auth_provider: 'ppbf_local',
      pin_hash: 'hash',
      active_flag: true,
      has_master_shadow_access: false,
      organization_status: 'active',
    });

    const result = await loginWithAccountIdAndPin('coach-1', '123456');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('loginWithMicrosoftEmail inserts a 24-hour expires_at', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'coach-ms-1',
      role: 'coach',
      organization_id: 'org-1',
      is_platform_owner: false,
      athlete_id: null,
      auth_provider: 'microsoft',
      active_flag: true,
      has_master_shadow_access: false,
      organization_status: 'active',
    });
    mockQuery.mockResolvedValueOnce([]);

    const before = Date.now();
    const result = await loginWithMicrosoftEmail('coach@example.com');
    const after = Date.now();

    expect(result).not.toBeNull();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('insert into pilot.session_tokens');
    expect(sql).toContain('expires_at');
    const expiresAt = params[3] as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_ABSOLUTE_LIFETIME_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_ABSOLUTE_LIFETIME_MS);
  });
});
