import { NextRequest } from 'next/server';

import { POST } from './route';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';
import { checkRateLimit, recordFailedAttempt, clearRateLimit } from '@/src/server/pilot/rateLimit';

jest.mock('@/src/server/pilot/auth', () => ({
  loginWithAccountIdAndPin: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: jest.fn(() => '127.0.0.1'),
  checkRateLimit: jest.fn(() => ({ isLimited: false })),
  recordFailedAttempt: jest.fn(),
  clearRateLimit: jest.fn(),
}));

const mockLogin = loginWithAccountIdAndPin as jest.Mock;
const mockCheckRateLimit = checkRateLimit as jest.Mock;
const mockRecordFailedAttempt = recordFailedAttempt as jest.Mock;
const mockClearRateLimit = clearRateLimit as jest.Mock;

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
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
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
    expect(mockRecordFailedAttempt).toHaveBeenCalledTimes(2);
  });

  test('returns 429 when account lockout is active', async () => {
    mockCheckRateLimit
      .mockReturnValueOnce({ isLimited: true, delayMs: 30000 })
      .mockReturnValueOnce({ isLimited: false });

    const res = await POST(request('acct-locked'));
    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test('clears rate-limit counters after successful login', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'b-token',
      principal: {
        accountId: 'acct-cookie-3',
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
        sessionToken: 'b-token',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-cookie-3'));
    expect(res.status).toBe(200);
    expect(mockClearRateLimit).toHaveBeenCalledTimes(2);
  });

  test('denies non-athlete PIN sessions for privileged roles', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'priv-token',
      principal: {
        accountId: 'coach-acct',
        role: 'coach',
        organizationId: 'org-1',
        athleteId: null,
        sessionToken: 'priv-token',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('coach-acct'));
    expect(res.status).toBe(401);
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
    expect(mockRecordFailedAttempt).toHaveBeenCalledTimes(2);
  });
});
