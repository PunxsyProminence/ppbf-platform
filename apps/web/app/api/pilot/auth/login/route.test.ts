import { NextRequest } from 'next/server';

import { POST } from './route';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';

jest.mock('@/src/server/pilot/auth', () => ({
  loginWithAccountIdAndPin: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockLogin = loginWithAccountIdAndPin as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function request(accountId: string) {
  return new NextRequest('http://localhost/api/pilot/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, pin: '123456' }),
  });
}

describe('POST /api/pilot/auth/login', () => {
  test('the session cookie maxAge matches the centralized 24-hour session lifetime', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'a-token',
      principal: {
        accountId: 'acct-cookie-1',
        role: 'coach',
        organizationId: 'org-1',
        athleteId: null,
        sessionToken: 'a-token',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-cookie-1'));
    expect(res.status).toBe(200);

    const setCookie = res.cookies.get('ppbf_pilot_session');
    expect(setCookie?.value).toBe('a-token');
    expect(setCookie?.maxAge).toBe(SESSION_ABSOLUTE_LIFETIME_SECONDS);
    expect(SESSION_ABSOLUTE_LIFETIME_SECONDS).toBe(24 * 60 * 60);
  });

  test('401 for invalid credentials, no cookie set', async () => {
    mockLogin.mockResolvedValueOnce(null);
    const res = await POST(request('acct-cookie-2'));
    expect(res.status).toBe(401);
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });
});
