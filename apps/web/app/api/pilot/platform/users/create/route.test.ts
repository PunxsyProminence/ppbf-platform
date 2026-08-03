import { NextRequest } from 'next/server';

import { POST } from './route';
import { createAthleteAccountPendingActivation } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  createAthleteAccountPendingActivation: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCreateAthleteAccount = jest.mocked(createAthleteAccountPendingActivation);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/platform/users/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockCreateAthleteAccount.mockResolvedValue(undefined);
});

// Athlete credentials sit outside the platform-owner tier -- the same boundary
// the PIN directory, PIN reset and session revocation hold. This route admitted
// ONLY the platform owner, and took organization_id from the request body, so
// the one role the rule excludes could null any child's PIN in any gym it named.
test('refuses the platform owner', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({
    accountId: 'platform-owner',
    role: 'platform_owner',
    organizationId: 'platform',
  }));

  const response = await post({
    organization_id: 'org-1',
    account_id: 'athlete-account',
    role: 'athlete',
    athlete_id: 'ath-1',
  });

  expect(response.status).toBe(403);
  expect(mockCreateAthleteAccount).not.toHaveBeenCalled();
});

test('an organization admin creates an athlete account pending activation', async () => {
  const response = await post({
    account_id: 'athlete-account',
    role: 'athlete',
    athlete_id: 'ath-1',
  });

  expect(response.status).toBe(200);
  expect(mockCreateAthleteAccount).toHaveBeenCalledWith('athlete-account', 'ath-1', 'org-1');
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    role: 'athlete',
    athlete_id: 'ath-1',
    account_state: 'pending_pin_activation',
  });
});

// The gym comes from the session. A caller naming a different one is refused
// rather than silently redirected, so a wrong integration fails loudly.
test('refuses an organization_id that is not the caller_s own', async () => {
  const response = await post({
    organization_id: 'org-2',
    account_id: 'athlete-account',
    role: 'athlete',
    athlete_id: 'ath-1',
  });

  expect(response.status).toBe(403);
  expect(mockCreateAthleteAccount).not.toHaveBeenCalled();
});

test('uses the session gym when the body names the same one', async () => {
  const response = await post({
    organization_id: 'org-1',
    account_id: 'athlete-account',
    role: 'athlete',
    athlete_id: 'ath-1',
  });

  expect(response.status).toBe(200);
  expect(mockCreateAthleteAccount).toHaveBeenCalledWith('athlete-account', 'ath-1', 'org-1');
});

// The route calls a create-only function now. The upsert it used to call reset
// the PIN, deactivated the account and revoked every session when the account
// already existed -- which a replayed request would do to a child in good
// standing.
test('propagates the refusal when the account already exists', async () => {
  mockCreateAthleteAccount.mockRejectedValueOnce(new Error('Account already exists'));

  const response = await post({
    account_id: 'athlete-account',
    role: 'athlete',
    athlete_id: 'ath-1',
  });

  // 409, not 400: jsonError maps an existing-resource conflict to Conflict, and
  // a caller retrying a create wants to know it collided rather than that it
  // sent something malformed.
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: 'Account already exists' });
});

test('rejects outdated privileged local-PIN role creation paths', async () => {
  const response = await post({
    account_id: 'coach-account',
    role: 'coach',
  });

  expect(response.status).toBe(400);
  expect(mockCreateAthleteAccount).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: 'Unsupported role: privileged accounts must be Microsoft-authenticated',
  });
});
