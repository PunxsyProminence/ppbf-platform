import { NextRequest } from 'next/server';

import { POST } from './route';
import { createAthleteAccount, createAthleteAccountPendingActivation } from '@/src/server/pilot/auth';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/auth', () => ({
  createAthleteAccountPendingActivation: jest.fn().mockResolvedValue(undefined),
  // Mocked purely so the test can assert it is NEVER reached. See below.
  createAthleteAccount: jest.fn().mockResolvedValue({ startingPin: '428913' }),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockPendingCreate = createAthleteAccountPendingActivation as jest.Mock;
const mockLiveCreate = createAthleteAccount as jest.Mock;

function principal(role = 'platform_owner') {
  return {
    accountId: 'owner@punxsyprominence.org',
    role,
    organizationId: 'org-platform',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/platform/athlete-shell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = { organization_id: 'org-beta', account_id: 'ath-account-9', athlete_id: 'ath-9' };

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/platform/athlete-shell', () => {
  test('creates an inert shell for the named organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(200);
    expect(mockPendingCreate).toHaveBeenCalledWith('ath-account-9', 'ath-9', 'org-beta');
  });

  /**
   * The regression this file exists for.
   *
   * This route is platform_owner-only and its own docblock promises a shell with
   * "no PIN and active_flag false". It used to call createAthleteAccount, which
   * writes active_flag = true with a usable pin_hash -- a live, signable account.
   *
   * That handed the platform owner the precise capability the docblock says they
   * are permanently excluded from. The shared starting PIN was public, login only
   * checks active_flag plus the PIN, and must_change_pin still permits the
   * change-PIN route -- so the owner could sign in as the athlete, set a PIN of
   * their own, and hold the account. Cross-organization, against a minor.
   *
   * If someone reaches for createAthleteAccount here again, this fails.
   */
  test('never mints a live, signable account', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await POST(makeRequest(validBody));

    expect(mockLiveCreate).not.toHaveBeenCalled();
  });

  // The PIN belongs to the gym, not to the platform tier. Even now that starting
  // PINs are generated per athlete, this response must never carry one.
  test('returns no PIN material to the platform owner', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(body).not.toHaveProperty('starting_pin');
    expect(JSON.stringify(body)).not.toContain('428913');
  });

  test('refuses a role that is not the platform owner', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(403);
    expect(mockPendingCreate).not.toHaveBeenCalled();
  });

  test.each(['organization_id', 'account_id', 'athlete_id'])('refuses a request missing %s', async (field) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    const body: Record<string, unknown> = { ...validBody };
    delete body[field];

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(mockPendingCreate).not.toHaveBeenCalled();
  });
});
