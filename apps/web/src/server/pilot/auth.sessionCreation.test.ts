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

import { loginWithAccountIdAndPin, loginWithMicrosoftEmail, resolvePrincipal } from './auth';
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
    const result = await loginWithAccountIdAndPin('acct-1', '482913');
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

  test('a legacy athlete row can never authenticate with the retired shared bootstrap PIN', async () => {
    mockQueryOne.mockResolvedValueOnce({
      account_id: 'legacy-athlete', role: 'athlete', organization_id: 'org-1', is_platform_owner: false,
      athlete_id: 'ath-legacy', auth_provider: 'ppbf_local', pin_hash: 'hash', must_change_pin: true,
      active_flag: true, has_master_shadow_access: false, organization_status: 'active',
    });

    const result = await loginWithAccountIdAndPin('legacy-athlete', '123456');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
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

// BASE-03 wiring. The policy matrix lives in credentialPolicy.test.ts; these
// prove the two load-bearing auth paths actually ask it, rather than that the
// helper returns the right answer in isolation.
//
// NODE_ENV is 'test' throughout this suite, so the fence is shut by default --
// which is why the existing non-athlete rejection above still holds. Only the
// cases that explicitly open it set both conditions, and they restore the
// environment afterwards.
const mutableEnv = process.env as Record<string, string | undefined>;

async function withOfflineRuntime<T>(run: () => Promise<T>): Promise<T> {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.PPBF_OFFLINE_RUNTIME;
  // Plain assignment, not Object.defineProperty: process.env is a proxy whose
  // setter is the only thing that actually writes, so defineProperty silently
  // leaves NODE_ENV as 'test' and the fence never opens.
  mutableEnv.NODE_ENV = 'development';
  process.env.PPBF_OFFLINE_RUNTIME = 'true';
  try {
    // Awaited inside the try, not returned from it: returning the promise
    // would restore the environment before auth.ts ever reads it, and every
    // fence-open case would fail for a reason that has nothing to do with the
    // policy under test.
    return await run();
  } finally {
    mutableEnv.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.PPBF_OFFLINE_RUNTIME;
    else process.env.PPBF_OFFLINE_RUNTIME = previousFlag;
  }
}

function localAccountRow(accountId: string, role: string) {
  return {
    account_id: accountId,
    role,
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: null,
    auth_provider: 'ppbf_local',
    pin_hash: 'hash',
    must_change_pin: false,
    active_flag: true,
    has_master_shadow_access: false,
    organization_status: 'active',
  };
}

function requestWithSession() {
  return { cookies: { get: () => ({ value: 'opaque-token' }) } } as never;
}

describe('BASE-03 offline local PIN wiring', () => {
  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s PIN login is refused outside the offline fence, before any session write', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));

    const result = await loginWithAccountIdAndPin(accountId, '482913');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('%s PIN login reaches session creation inside the offline fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const result = await withOfflineRuntime(() => loginWithAccountIdAndPin(accountId, '482913'));

    expect(result).not.toBeNull();
    expect(result?.principal.role).toBe(role);
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });

  test('the athlete PIN path is unchanged by the fence', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...localAccountRow('ath-1', 'athlete'), athlete_id: 'a-1' });
    mockQuery.mockResolvedValueOnce([]);

    const result = await loginWithAccountIdAndPin('ath-1', '482913');

    expect(result).not.toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('insert into pilot.session_tokens');
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a ppbf_local %s session is revoked on sight outside the offline fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));
    mockQuery.mockResolvedValueOnce([]);

    const principal = await resolvePrincipal(requestWithSession());

    expect(principal).toBeNull();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('update pilot.session_tokens set revoked_at');
  });

  test.each([
    ['organization_admin', 'admin-1'],
    ['coach', 'coach-1'],
  ])('a ppbf_local %s session survives inside the offline fence', async (role, accountId) => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow(accountId, role));

    const principal = await withOfflineRuntime(() => resolvePrincipal(requestWithSession()));

    expect(principal).not.toBeNull();
    expect(principal?.role).toBe(role);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a ppbf_local parent session is still revoked even inside the offline fence', async () => {
    mockQueryOne.mockResolvedValueOnce(localAccountRow('parent-1', 'parent'));
    mockQuery.mockResolvedValueOnce([]);

    const principal = await withOfflineRuntime(() => resolvePrincipal(requestWithSession()));

    expect(principal).toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('update pilot.session_tokens set revoked_at');
  });
});
