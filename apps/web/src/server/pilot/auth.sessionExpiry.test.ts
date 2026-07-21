import { NextRequest } from 'next/server';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { resolvePrincipal } from './auth';
import { queryOne } from './db';
import { PILOT_SESSION_COOKIE } from './env';

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function requestWithToken(token = 'a-real-session-token') {
  return new NextRequest('http://localhost/api/pilot/whatever', {
    headers: { cookie: `${PILOT_SESSION_COOKIE}=${token}` },
  });
}

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'acct-1',
    role: 'coach',
    organization_id: 'org-1',
    is_platform_owner: false,
    athlete_id: null,
    auth_provider: 'ppbf_local',
    active_flag: true,
    has_master_shadow_access: false,
    organization_status: 'active',
    ...overrides,
  };
}

describe('resolvePrincipal', () => {
  test('returns null when there is no session cookie', async () => {
    const request = new NextRequest('http://localhost/api/pilot/whatever');
    expect(await resolvePrincipal(request)).toBeNull();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('returns a principal for a valid, unexpired, unrevoked session', async () => {
    mockQueryOne.mockResolvedValueOnce(validRow());
    const principal = await resolvePrincipal(requestWithToken());
    expect(principal).not.toBeNull();
    expect(principal?.accountId).toBe('acct-1');
    expect(principal?.role).toBe('coach');
  });

  test('the underlying query enforces revocation, expiration, and active membership in SQL', async () => {
    mockQueryOne.mockResolvedValueOnce(validRow());
    await resolvePrincipal(requestWithToken());

    const [sql] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('st.revoked_at is null');
    expect(sql).toContain('st.expires_at > now()');
    expect(sql).toContain('pilot.organization_memberships');
    expect(sql).toContain('om.active_flag = true');
  });

  test('rejects an expired session (simulated by the DB filter returning no row)', async () => {
    // A real database with `and st.expires_at > now()` in the WHERE clause
    // returns no row for an expired session; queryOne surfaces that as null.
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await resolvePrincipal(requestWithToken())).toBeNull();
  });

  test('rejects a legacy session with no expires_at (the migration revokes it, so the DB filter also excludes it)', async () => {
    // Any pre-migration session either got revoked_at set or, in SQL, a null
    // expires_at makes `expires_at > now()` evaluate to NULL (falsy), so it
    // is excluded by the same WHERE clause either way.
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await resolvePrincipal(requestWithToken())).toBeNull();
  });

  test('rejects a revoked session (simulated by the DB filter returning no row)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await resolvePrincipal(requestWithToken())).toBeNull();
  });

  test('rejects an inactive account', async () => {
    mockQueryOne.mockResolvedValueOnce(validRow({ active_flag: false }));
    expect(await resolvePrincipal(requestWithToken())).toBeNull();
  });

  test('rejects a session in an inactive organization', async () => {
    mockQueryOne.mockResolvedValueOnce(validRow({ organization_status: 'suspended' }));
    expect(await resolvePrincipal(requestWithToken())).toBeNull();
  });

  test('platform_owner bypasses the inactive-organization check (preserves existing identity model)', async () => {
    mockQueryOne.mockResolvedValueOnce(
      validRow({ is_platform_owner: true, organization_status: 'suspended' }),
    );
    expect(await resolvePrincipal(requestWithToken())).not.toBeNull();
  });

  test('rejects a session whose organization has no active membership row for the account (missing or inactive membership, or org mismatch)', async () => {
    // The inner join on an active pilot.organization_memberships row means a
    // real database returns no row for any of: no membership row at all, an
    // inactive membership, or a session organization_id that doesn't match
    // any membership the account actually holds.
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await resolvePrincipal(requestWithToken())).toBeNull();
  });
});
