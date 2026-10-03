jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  isLoopbackPostgresConnectionString: jest.requireActual('./db').isLoopbackPostgresConnectionString,
}));

jest.mock('./security', () => ({
  createOpaqueToken: jest.fn(() => 'opaque-token'),
  hashToken: jest.fn(() => 'hashed-token'),
  hashPin: jest.fn(),
  verifyPin: jest.fn(async () => true),
}));

import { loginWithAccountIdAndPin, loginWithMicrosoftEmail, resolvePrincipal } from './auth';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

// A session or sign-in with no organization is refused. It used to be scoped
// to the deployment's default organization instead -- an organization the
// account was never placed in. The default is set here so that, if the
// fallback came back, every refusal below would turn into a session.
const previousDefaultOrg = process.env.PPBF_PILOT_DEFAULT_ORG_ID;
beforeAll(() => {
  process.env.PPBF_PILOT_DEFAULT_ORG_ID = 'org-default';
});
afterAll(() => {
  if (previousDefaultOrg === undefined) delete process.env.PPBF_PILOT_DEFAULT_ORG_ID;
  else process.env.PPBF_PILOT_DEFAULT_ORG_ID = previousDefaultOrg;
});

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  jest.clearAllMocks();
});

function pinAccountRow(organizationId: string | null) {
  return {
    account_id: 'ath-acct',
    role: 'athlete',
    organization_id: organizationId,
    is_platform_owner: false,
    athlete_id: 'ath-1',
    auth_provider: 'ppbf_local',
    pin_hash: 'hash',
    must_change_pin: false,
    active_flag: true,
    account_deleted: false,
    has_master_shadow_access: false,
    organization_status: null,
    holds_board_seat: false,
  };
}

function microsoftAccountRow(organizationId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'coach@example.com',
    role: 'coach',
    organization_id: organizationId,
    is_platform_owner: false,
    athlete_id: null,
    auth_provider: 'microsoft',
    active_flag: true,
    account_deleted: false,
    has_master_shadow_access: false,
    organization_status: null,
    ...overrides,
  };
}

function sessionRow(organizationId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    ...microsoftAccountRow(organizationId),
    must_change_pin: false,
    holds_board_seat: false,
    ...overrides,
  };
}

function requestWithSession() {
  return { cookies: { get: () => ({ value: 'opaque-token' }) } } as never;
}

describe('PIN sign-in', () => {
  test.each([null, ''])('refuses an account with organization %p before writing a session', async (organizationId) => {
    mockQueryOne.mockResolvedValueOnce(pinAccountRow(organizationId));

    const result = await loginWithAccountIdAndPin('ath-acct', '482913');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('pilot-auth login rejected', { accountId: 'ath-acct', reason: 'no_organization' });
  });

  test('control: an account with an organization signs in, scoped to that organization', async () => {
    mockQueryOne.mockResolvedValueOnce(pinAccountRow('org-1'));
    mockQuery.mockResolvedValueOnce([]);

    const result = await loginWithAccountIdAndPin('ath-acct', '482913');

    expect(result?.principal.organizationId).toBe('org-1');
    expect(mockQuery.mock.calls[0][1][2]).toBe('org-1');
  });
});

describe('Microsoft sign-in', () => {
  test.each([null, ''])('refuses an account with organization %p before writing a session', async (organizationId) => {
    mockQueryOne.mockResolvedValueOnce(microsoftAccountRow(organizationId));

    const result = await loginWithMicrosoftEmail('coach@example.com');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses a platform owner with no organization too', async () => {
    mockQueryOne.mockResolvedValueOnce(microsoftAccountRow(null, {
      account_id: 'admin@punxsyprominence.org',
      role: 'platform_owner',
      is_platform_owner: true,
    }));

    const result = await loginWithMicrosoftEmail('admin@punxsyprominence.org');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('control: an account with an organization signs in, scoped to that organization', async () => {
    mockQueryOne.mockResolvedValueOnce(microsoftAccountRow('org-1'));
    mockQuery.mockResolvedValueOnce([]);

    const result = await loginWithMicrosoftEmail('coach@example.com');

    expect(result?.principal.organizationId).toBe('org-1');
    expect(mockQuery.mock.calls[0][1][2]).toBe('org-1');
  });
});

describe('session resolution', () => {
  test.each([null, ''])('resolves a session whose organization is %p to nobody', async (organizationId) => {
    mockQueryOne.mockResolvedValueOnce(sessionRow(organizationId));

    await expect(resolvePrincipal(requestWithSession())).resolves.toBeNull();
  });

  test('resolves an athlete PIN session with no organization to nobody', async () => {
    mockQueryOne.mockResolvedValueOnce(sessionRow(null, {
      account_id: 'ath-acct', role: 'athlete', athlete_id: 'ath-1', auth_provider: 'ppbf_local',
    }));

    await expect(resolvePrincipal(requestWithSession())).resolves.toBeNull();
  });

  test('control: a session with an organization resolves to that organization', async () => {
    mockQueryOne.mockResolvedValueOnce(sessionRow('org-1'));

    const principal = await resolvePrincipal(requestWithSession());

    expect(principal?.organizationId).toBe('org-1');
  });
});
