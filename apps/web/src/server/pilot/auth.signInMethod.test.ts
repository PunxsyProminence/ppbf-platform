// Audit CL-A7: the "Microsoft-authenticated session" gate read the ACCOUNT's
// auth_provider, which staff provisioning sets to 'microsoft' for coaches,
// staff, volunteers and parents who sign in by emailed link or password. The
// session row already has a sign_in_method column; the Microsoft and PIN
// inserts did not fill it. These pin that both now record how the session was
// signed in, and that resolvePrincipal carries it.

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

afterEach(() => {
  jest.clearAllMocks();
});

function sessionInsert() {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('insert into pilot.session_tokens'));
  if (!call) throw new Error('no session insert');
  return { sql: String(call[0]), params: call[1] as unknown[] };
}

test("a Microsoft sign-in records sign_in_method 'microsoft' on its session", async () => {
  mockQueryOne.mockResolvedValueOnce({
    account_id: 'coach-ms-1',
    role: 'coach',
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: null,
    auth_provider: 'microsoft',
    active_flag: true,
    account_deleted: false,
    has_master_shadow_access: false,
    organization_status: 'active',
  });
  mockQuery.mockResolvedValueOnce([]);

  const result = await loginWithMicrosoftEmail('coach@example.com');

  const { sql, params } = sessionInsert();
  expect(sql).toContain('sign_in_method');
  expect(params).toHaveLength(4);
  expect(sql).toContain("values ($1, $2, $3, $4, 'microsoft')");
  expect(result?.principal.signInMethod).toBe('microsoft');
});

test("a PIN sign-in records sign_in_method 'pin' on its session", async () => {
  mockQueryOne.mockResolvedValueOnce({
    account_id: 'acct-1',
    role: 'athlete',
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: 'ath-1',
    auth_provider: 'ppbf_local',
    pin_hash: 'hash',
    active_flag: true,
    account_deleted: false,
    has_master_shadow_access: false,
    organization_status: 'active',
  });
  mockQuery.mockResolvedValueOnce([]);

  const result = await loginWithAccountIdAndPin('acct-1', '482913');

  const { sql, params } = sessionInsert();
  expect(sql).toContain('sign_in_method');
  expect(params).toHaveLength(4);
  expect(sql).toContain("values ($1, $2, $3, $4, 'pin')");
  expect(result?.principal.signInMethod).toBe('pin');
});

function sessionRow(signInMethod: string | null) {
  return {
    account_id: 'coach-1',
    role: 'coach',
    home_role: 'coach',
    home_organization_id: 'org-1',
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: null,
    auth_provider: 'microsoft',
    active_flag: true,
    has_master_shadow_access: false,
    must_change_pin: false,
    organization_status: 'active',
    holds_board_seat: false,
    sign_in_method: signInMethod,
  };
}

const request = { cookies: { get: () => ({ value: 'opaque-token' }) } } as never;

test.each(['magic_link', 'password', 'microsoft'])(
  "resolvePrincipal carries the session's sign_in_method (%s), not the account's provider",
  async (method) => {
    mockQueryOne.mockResolvedValueOnce(sessionRow(method));

    const principal = await resolvePrincipal(request);

    expect(principal?.signInMethod).toBe(method);
    expect(String(mockQueryOne.mock.calls[0][0])).toContain('st.sign_in_method');
  },
);

test('a session minted before sign_in_method was recorded resolves with null', async () => {
  mockQueryOne.mockResolvedValueOnce(sessionRow(null));

  const principal = await resolvePrincipal(request);

  expect(principal).not.toBeNull();
  expect(principal?.signInMethod).toBeNull();
});
