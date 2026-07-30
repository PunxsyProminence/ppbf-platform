import { NextRequest } from 'next/server';

import { GET } from './route';
import { loginWithMicrosoftEmail } from '@/src/server/pilot/auth';
import { getMsOidcConfig } from '@/src/server/pilot/federatedAuth';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

jest.mock('@/src/server/pilot/auth', () => ({
  loginWithMicrosoftEmail: jest.fn(),
}));

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
const mockGetMsOidcConfig = jest.mocked(getMsOidcConfig);
const originalPrimaryOwnerEmail = process.env.PPBF_PRIMARY_OWNER_EMAIL;

beforeEach(() => {
  process.env.PPBF_PRIMARY_OWNER_EMAIL = 'owner@example.com';
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
    ['organization_admin', '/admin'],
    ['admin', '/admin'],
    ['coach', '/coach/review-queue'],
    ['athlete', '/athlete/dashboard'],
    ['parent', '/parent/dashboard'],
    ['board', '/board'],
  ])('redirects authenticated %s from the server principal to %s', async (role, expectedPath) => {
    mockLogin.mockResolvedValueOnce(microsoftLogin(role));

    const res = await GET(request());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`https://ppbf.example${expectedPath}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe(`${role}-token`);
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
