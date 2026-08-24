import { NextRequest } from 'next/server';

import { GET } from './route';
import { loginWithMicrosoftEmail } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { listSeatsForAccount } from '@/src/server/pilot/boardSeats';
import { getMsOidcConfig } from '@/src/server/pilot/federatedAuth';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

jest.mock('@/src/server/pilot/auth', () => ({
  loginWithMicrosoftEmail: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// A board member lands on the seat they hold, so the callback reads seats
// before building the redirect. The real resolveLandingSeat is kept -- only
// the database read is faked.
jest.mock('@/src/server/pilot/boardSeats', () => {
  const actual = jest.requireActual('@/src/server/pilot/boardSeats');
  return { ...actual, listSeatsForAccount: jest.fn(async () => []) };
});

jest.mock('@/src/server/pilot/federatedAuth', () => ({
  getMsOidcConfig: jest.fn(() => ({
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    callbackUrl: 'https://ppbf.example/api/pilot/auth/microsoft/callback',
    postLoginPath: '',
  })),
  fetchOidcDiscovery: jest.fn(async () => ({})),
  exchangeCodeForIdToken: jest.fn(async () => 'id-token'),
  verifyAndDecodeMicrosoftIdToken: jest.fn(async () => ({})),
  resolveMicrosoftIdentityEmail: jest.fn(() => 'owner@example.com'),
}));

jest.mock('@/src/server/pilot/microsoftOAuthFlow', () => {
  const actual = jest.requireActual('@/src/server/pilot/microsoftOAuthFlow');
  return {
    ...actual,
    validateOAuthState: jest.fn(() => ({ ok: true })),
    shouldEmitAuthDiagnostics: jest.fn(() => false),
    shouldUseSecureCookie: jest.fn(() => true),
    resolvePublicOrigin: jest.fn(() => 'https://ppbf.example'),
  };
});

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({
    get: (name: string) => {
      const values: Record<string, string> = {
        ppbf_ms_auth_state: 'state-1',
        ppbf_ms_auth_verifier: 'verifier-1',
        ppbf_ms_auth_nonce: 'nonce-1',
        ppbf_ms_auth_issued_at: String(Math.floor(Date.now() / 1000)),
      };
      return values[name] ? { value: values[name] } : undefined;
    },
  })),
}));

const mockLogin = loginWithMicrosoftEmail as jest.Mock;
const mockWritePilotAuditEvent = writePilotAuditEvent as jest.Mock;
const mockListSeatsForAccount = jest.mocked(listSeatsForAccount);
const mockGetMsOidcConfig = jest.mocked(getMsOidcConfig);
const originalPrimaryOwnerEmail = process.env.PPBF_PRIMARY_OWNER_EMAIL;

beforeEach(() => {
  process.env.PPBF_PRIMARY_OWNER_EMAIL = 'owner@example.com';
  mockWritePilotAuditEvent.mockResolvedValue(undefined);
  mockGetMsOidcConfig.mockReturnValue({
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    callbackUrl: 'https://ppbf.example/api/pilot/auth/microsoft/callback',
    postLoginPath: '',
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  if (originalPrimaryOwnerEmail === undefined) {
    delete process.env.PPBF_PRIMARY_OWNER_EMAIL;
  } else {
    process.env.PPBF_PRIMARY_OWNER_EMAIL = originalPrimaryOwnerEmail;
  }
});

function request() {
  return new NextRequest('https://ppbf.example/api/pilot/auth/microsoft/callback?state=state-1&code=auth-code-1');
}

function microsoftLogin(role: string, token = `${role}-token`) {
  return {
    token,
    principal: {
      accountId: 'owner@example.com',
      role,
      organizationId: 'org-1',
      athleteId: role === 'athlete' ? 'athlete-1' : null,
      sessionToken: token,
      authProvider: 'microsoft',
    },
  };
}

describe('GET /api/pilot/auth/microsoft/callback', () => {
  test('the session cookie maxAge matches the centralized 24-hour session lifetime, same as local login', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'ms-token',
      principal: {
        accountId: 'owner@example.com',
        role: 'coach',
        organizationId: 'org-1',
        athleteId: null,
        sessionToken: 'ms-token',
        authProvider: 'microsoft',
      },
    });

    const res = await GET(request());
    expect(res.status).toBe(307);

    const setCookie = res.cookies.get('ppbf_pilot_session');
    expect(setCookie?.value).toBe('ms-token');
    expect(setCookie?.maxAge).toBe(SESSION_ABSOLUTE_LIFETIME_SECONDS);
  });

  test('redirects to login without setting a session cookie when the identity is not invited', async () => {
    mockLogin.mockResolvedValueOnce(null);
    const res = await GET(request());
    expect(res.status).toBe(307);
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });

  test.each([
    ['platform_owner', '/admin/platform'],
    ['organization_admin', '/admin/people'],
    ['admin', '/admin/people'],
    ['coach', '/coach/environment/intake-router'],
    ['athlete', '/athlete/dashboard'],
    ['parent', '/parent/dashboard'],
    ['board', '/board'],
    ['staff', '/workspace'],
    ['volunteer', '/workspace'],
  ])('redirects authenticated %s from the server principal to %s', async (role, expectedPath) => {
    mockLogin.mockResolvedValueOnce(microsoftLogin(role));

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`https://ppbf.example${expectedPath}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe(`${role}-token`);
  });

  // The seat is why board seats exist: a treasurer signing in should reach the
  // treasurer workspace, not the shared hub they would have to navigate out of.
  test('a seated board member lands on their own seat page', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('board'));
    mockListSeatsForAccount.mockResolvedValueOnce([{ seat: 'treasurer', is_primary: true }]);

    const res = await GET(request());

    expect(res.headers.get('location')).toBe('https://ppbf.example/board/treasurer');
  });

  test('a board member holding no seat still lands on the shared hub', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('board'));
    mockListSeatsForAccount.mockResolvedValueOnce([]);

    const res = await GET(request());

    expect(res.headers.get('location')).toBe('https://ppbf.example/board');
  });

  test('no seat lookup happens for a role that cannot hold one', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('coach'));

    await GET(request());

    expect(mockListSeatsForAccount).not.toHaveBeenCalled();
  });

  test('ignores a configured catch-all post-login path and preserves role-derived routing', async () => {
    mockGetMsOidcConfig.mockReturnValueOnce({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      callbackUrl: 'https://ppbf.example/api/pilot/auth/microsoft/callback',
      postLoginPath: '/admin/organizations',
    });
    mockLogin.mockResolvedValueOnce(microsoftLogin('athlete'));

    const res = await GET(request());

    expect(res.headers.get('location')).toBe('https://ppbf.example/athlete/dashboard');
  });

  test('fails closed instead of routing an unsupported authenticated role to admin', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('future_privileged_role'));

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://ppbf.example/login?error=auth-forbidden');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });
});

/**
 * THE DOOR THAT RECORDED NOTHING.
 *
 * The sign-in panel told every user "Access logged". This route -- the only
 * way in for platform_owner, organization_admin, admin and board -- contained
 * no audit write of any kind, so the four highest-privilege roles on a
 * platform holding children's records were the only ones signing in without a
 * trace. PIN and magic-link had written a 'login' row since each shipped.
 *
 * The write added here is success-only and uses the existing 'login' event
 * type, so it needs no vocabulary change and no migration. Refused sign-ins
 * are still not recorded -- on any door -- because there is no failure type to
 * record them with; the panel copy no longer claims otherwise.
 */
describe('the Microsoft door records the sign-in it grants', () => {
  test.each([
    ['platform_owner'],
    ['organization_admin'],
    ['admin'],
    ['board'],
  ])('a successful %s sign-in writes the login row this route never wrote', async (role) => {
    mockLogin.mockResolvedValueOnce(microsoftLogin(role));

    await GET(request());

    expect(mockWritePilotAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockWritePilotAuditEvent).toHaveBeenCalledWith({
      event_type: 'login',
      actor_account_id: 'owner@example.com',
      actor_role: role,
      organization_id: 'org-1',
      entity_type: 'account',
      entity_id: 'owner@example.com',
      details: { auth_provider: 'microsoft', hasMasterShadowAccess: false },
    });
  });

  // The row must say which door was used, or a Microsoft sign-in is
  // indistinguishable in the audit stream from a PIN one -- and only one of
  // those two can reach the admin surfaces.
  test('the row names the provider that let them in', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('admin'));

    await GET(request());

    expect(mockWritePilotAuditEvent.mock.calls[0][0].details).toEqual(
      expect.objectContaining({ auth_provider: 'microsoft' }),
    );
  });

  test('master SHADOW access is carried on the row, as the PIN door already does', async () => {
    const login = microsoftLogin('platform_owner');
    mockLogin.mockResolvedValueOnce({
      ...login,
      principal: { ...login.principal, hasMasterShadowAccess: true },
    });

    await GET(request());

    expect(mockWritePilotAuditEvent.mock.calls[0][0].details).toEqual(
      expect.objectContaining({ hasMasterShadowAccess: true }),
    );
  });

  test('an identity that is not invited is not recorded as having signed in', async () => {
    mockLogin.mockResolvedValueOnce(null);

    const res = await GET(request());

    expect(mockWritePilotAuditEvent).not.toHaveBeenCalled();
    // Outcome unchanged by the write being added.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://ppbf.example/login?error=not-invited');
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });

  test('a role that fails the destination check is not recorded as having signed in', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('future_privileged_role'));

    const res = await GET(request());

    expect(mockWritePilotAuditEvent).not.toHaveBeenCalled();
    // Outcome unchanged by the write being added.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://ppbf.example/login?error=auth-forbidden');
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });
});

/**
 * NO REQUEST CHANGES OUTCOME BECAUSE OF THE AUDIT WRITE.
 *
 * loginWithMicrosoftEmail has already inserted the pilot.session_tokens row by
 * the time the write runs, and every throw in the handler is caught into a
 * redirect to /login?error=auth-failed. So an unwrapped write would convert a
 * database blip into a locked-out administrator holding a live session with no
 * cookie -- adding an outage to the auth path in the name of recording it.
 */
describe('the audit write cannot change who gets in', () => {
  test('a failing audit write still admits a sign-in that succeeded', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('platform_owner'));
    mockWritePilotAuditEvent.mockRejectedValueOnce(Object.assign(new Error('audit down'), { code: '57P01' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://ppbf.example/admin/platform');
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe('platform_owner-token');
    expect(res.cookies.get('ppbf_pilot_session')?.maxAge).toBe(SESSION_ABSOLUTE_LIFETIME_SECONDS);

    consoleError.mockRestore();
  });

  // The log line is the only trace left when the row is lost, so it has to
  // carry the SQLSTATE -- and nothing else. sanitizedSqlState rejects anything
  // that is not five uppercase alphanumerics, so a driver cannot smuggle an
  // arbitrary string (a connection string, a query) into the log through it.
  test('a failing audit write is logged as a shape, never as an identity', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('admin'));
    mockWritePilotAuditEvent.mockRejectedValueOnce(Object.assign(new Error('audit down'), { code: '57P01' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await GET(request());

    expect(consoleError).toHaveBeenCalledWith({
      event: 'pilot-auth-microsoft-audit-write-failed',
      code: '57P01',
    });
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain('owner@example.com');
    expect(logged).not.toContain('audit down');

    consoleError.mockRestore();
  });

  test('a malformed SQLSTATE is dropped rather than logged', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('admin'));
    mockWritePilotAuditEvent.mockRejectedValueOnce(
      Object.assign(new Error('audit down'), { code: 'postgres://user:pw@host/db' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await GET(request());

    expect(consoleError).toHaveBeenCalledWith({ event: 'pilot-auth-microsoft-audit-write-failed' });

    consoleError.mockRestore();
  });

  test('the seat lookup a board member needs still runs, and still decides the landing page', async () => {
    mockLogin.mockResolvedValueOnce(microsoftLogin('board'));
    mockListSeatsForAccount.mockResolvedValueOnce([{ seat: 'treasurer', is_primary: true }]);
    mockWritePilotAuditEvent.mockRejectedValueOnce(new Error('audit down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request());

    expect(res.headers.get('location')).toBe('https://ppbf.example/board/treasurer');
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe('board-token');

    consoleError.mockRestore();
  });
});
